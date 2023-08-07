import type { HandshakeReusedEvent } from './domain/OutOfBandEvents'
import type { AgentMessageReceivedEvent } from '../../agent/Events'
import type { V2Attachment, Attachment } from '../../decorators/attachment'
import type { PlaintextMessage, DidCommV2Message, DidCommV1Message } from '../../didcomm'
import type { Query } from '../../storage/StorageService'
import type { ConnectionInvitationMessage, ConnectionRecord, Routing } from '../connections'

import { catchError, EmptyError, first, firstValueFrom, map, of, timeout } from 'rxjs'

import { AgentContext } from '../../agent'
import { EventEmitter } from '../../agent/EventEmitter'
import { filterContextCorrelationId, AgentEventTypes } from '../../agent/Events'
import { MessageHandlerRegistry } from '../../agent/MessageHandlerRegistry'
import { MessageSender } from '../../agent/MessageSender'
import { OutboundMessageContext } from '../../agent/models'
import { InjectionSymbols } from '../../constants'
import { Key } from '../../crypto'
import { createJSONV2Attachment } from '../../decorators/attachment'
import { ServiceDecorator } from '../../decorators/service/ServiceDecorator'
import { getPlaintextMessageType } from '../../didcomm'
import { AriesFrameworkError } from '../../error'
import { Logger } from '../../logger'
import { inject, injectable } from '../../plugins'
import { DidCommMessageRepository } from '../../storage'
import { JsonEncoder, JsonTransformer } from '../../utils'
import { parseMessageType, supportsIncomingMessageType } from '../../utils/messageType'
import { parseInvitationShortUrl } from '../../utils/parseInvitation'
import { uuid } from '../../utils/uuid'
import { ConnectionsApi, DidExchangeState, HandshakeProtocol } from '../connections'
import { DidCommDocumentService } from '../didcomm'
import { DidKey } from '../dids'
import { RoutingService } from '../routing/services/RoutingService'

import { OutOfBandDidCommService } from './domain/OutOfBandDidCommService'
import { OutOfBandEventTypes } from './domain/OutOfBandEvents'
import { OutOfBandRole } from './domain/OutOfBandRole'
import { OutOfBandState } from './domain/OutOfBandState'
import { convertToNewInvitation, convertToOldInvitation } from './helpers'
import { OutOfBandService } from './protocols/v1/OutOfBandService'
import { HandshakeReuseHandler } from './protocols/v1/handlers'
import { HandshakeReuseAcceptedHandler } from './protocols/v1/handlers/HandshakeReuseAcceptedHandler'
import { OutOfBandInvitation } from './protocols/v1/messages'
import { V2OutOfBandService } from './protocols/v2/V2OutOfBandService'
import { V2OutOfBandInvitation } from './protocols/v2/messages'
import { OutOfBandRecord } from './repository/OutOfBandRecord'
import { OutOfBandRecordMetadataKeys } from './repository/outOfBandRecordMetadataTypes'

const didCommProfiles = ['didcomm/aip1', 'didcomm/aip2;env=rfc19']

export enum OutOfBandVersion {
  V1 = 'v1',
  V2 = 'v2',
}

export type CreateOutOfBandInvitationConfig = CreateV11OutOfBandInvitationConfig | CreateV20OutOfBandInvitationConfig

export interface BaseCreateOutOfBandInvitationConfig {
  alias?: string // alias for a connection record to be created
  goalCode?: string
  goal?: string
}

export interface CreateV11OutOfBandInvitationConfig extends BaseCreateOutOfBandInvitationConfig {
  version?: OutOfBandVersion.V1
  label?: string
  imageUrl?: string
  handshake?: boolean
  handshakeProtocols?: HandshakeProtocol[]
  messages?: DidCommV1Message[]
  multiUseInvitation?: boolean
  autoAcceptConnection?: boolean
  routing?: Routing
  appendedAttachments?: Attachment[]
}

export interface CreateV20OutOfBandInvitationConfig extends BaseCreateOutOfBandInvitationConfig {
  version: OutOfBandVersion.V2
  accept?: Array<string>
  messages?: DidCommV2Message[]
  appendedAttachments?: V2Attachment[]
}

export interface CreateLegacyInvitationConfig {
  label?: string
  alias?: string // alias for a connection record to be created
  imageUrl?: string
  multiUseInvitation?: boolean
  autoAcceptConnection?: boolean
  routing?: Routing
}

interface BaseReceiveOutOfBandInvitationConfig {
  label?: string
  alias?: string
  imageUrl?: string
  autoAcceptInvitation?: boolean
  autoAcceptConnection?: boolean
  reuseConnection?: boolean
  routing?: Routing
  acceptInvitationTimeoutMs?: number
  isImplicit?: boolean
}

export type ReceiveOutOfBandInvitationConfig = Omit<BaseReceiveOutOfBandInvitationConfig, 'isImplicit'>

export interface ReceiveOutOfBandImplicitInvitationConfig
  extends Omit<BaseReceiveOutOfBandInvitationConfig, 'isImplicit' | 'reuseConnection'> {
  did: string
  handshakeProtocols?: HandshakeProtocol[]
}

@injectable()
export class OutOfBandApi {
  private outOfBandService: OutOfBandService
  private v2OutOfBandService: V2OutOfBandService
  private routingService: RoutingService
  private connectionsApi: ConnectionsApi
  private didCommMessageRepository: DidCommMessageRepository
  private messageHandlerRegistry: MessageHandlerRegistry
  private didCommDocumentService: DidCommDocumentService
  private messageSender: MessageSender
  private eventEmitter: EventEmitter
  private agentContext: AgentContext
  private logger: Logger

  public constructor(
    messageHandlerRegistry: MessageHandlerRegistry,
    didCommDocumentService: DidCommDocumentService,
    outOfBandService: OutOfBandService,
    v2OutOfBandService: V2OutOfBandService,
    routingService: RoutingService,
    connectionsApi: ConnectionsApi,
    didCommMessageRepository: DidCommMessageRepository,
    messageSender: MessageSender,
    eventEmitter: EventEmitter,
    @inject(InjectionSymbols.Logger) logger: Logger,
    agentContext: AgentContext
  ) {
    this.messageHandlerRegistry = messageHandlerRegistry
    this.didCommDocumentService = didCommDocumentService
    this.agentContext = agentContext
    this.logger = logger
    this.outOfBandService = outOfBandService
    this.v2OutOfBandService = v2OutOfBandService
    this.routingService = routingService
    this.connectionsApi = connectionsApi
    this.didCommMessageRepository = didCommMessageRepository
    this.messageSender = messageSender
    this.eventEmitter = eventEmitter
    this.registerMessageHandlers(messageHandlerRegistry)
  }

  /**
   * Creates an outbound out-of-band record containing out-of-band invitation message of requested version
   *  - `v1` and default -  Aries RFC 0434: Out-of-Band Protocol 1.1.
   *  - `v2` -  DIDComm Messaging v2.x: Out-of-Band Protocol 2.0.
   *
   * For `v1`:
   *    It automatically adds all supported handshake protocols by agent to `handshake_protocols`. You
   *    can modify this by setting `handshakeProtocols` in `config` parameter. If you want to create
   *    invitation without handshake, you can set `handshake` to `false`.
   *
   *    If `config` parameter contains `messages` it adds them to `requests~attach` attribute.
   *
   *    Agent role: sender (inviter)
   *
   * @param config configuration of how out-of-band invitation should be created
   * @returns out-of-band record
   */
  public async createInvitation(config: CreateOutOfBandInvitationConfig = {}): Promise<OutOfBandRecord> {
    let outOfBandRecord: OutOfBandRecord | null
    if (config.version === OutOfBandVersion.V2) {
      const attachments: Array<V2Attachment> = config.appendedAttachments || []
      for (const message of config.messages || []) {
        attachments.push(createJSONV2Attachment(uuid(), message.toJSON()))
      }
      const params = {
        goal: config.goal,
        goalCode: config.goalCode,
        accept: config.accept,
        attachments,
      }
      const outOfBandInvitation = await this.v2OutOfBandService.createInvitation(this.agentContext, params)
      outOfBandRecord = new OutOfBandRecord({
        role: OutOfBandRole.Sender,
        state: OutOfBandState.AwaitResponse,
        alias: config.alias,
        v2OutOfBandInvitation: outOfBandInvitation,
      })
    } else {
      const multiUseInvitation = config.multiUseInvitation ?? false
      const handshake = config.handshake ?? true
      const customHandshakeProtocols = config.handshakeProtocols
      const autoAcceptConnection = config.autoAcceptConnection ?? this.connectionsApi.config.autoAcceptConnections
      // We don't want to treat an empty array as messages being provided
      const messages = config.messages && config.messages.length > 0 ? config.messages : undefined
      const label = config.label ?? this.agentContext.config.label
      const imageUrl = config.imageUrl ?? this.agentContext.config.connectionImageUrl
      const appendedAttachments =
        config.appendedAttachments && config.appendedAttachments.length > 0 ? config.appendedAttachments : undefined

      if (!handshake && !messages) {
        throw new AriesFrameworkError(
          'One or both of handshake_protocols and requests~attach MUST be included in the message.'
        )
      }

      if (!handshake && customHandshakeProtocols) {
        throw new AriesFrameworkError(`Attribute 'handshake' can not be 'false' when 'handshakeProtocols' is defined.`)
      }

      // For now we disallow creating multi-use invitation with attachments. This would mean we need multi-use
      // credential and presentation exchanges.
      if (messages && multiUseInvitation) {
        throw new AriesFrameworkError("Attribute 'multiUseInvitation' can not be 'true' when 'messages' is defined.")
      }

      let handshakeProtocols
      if (handshake) {
        // Find supported handshake protocol preserving the order of handshake protocols defined
        // by agent
        if (customHandshakeProtocols) {
          this.assertHandshakeProtocols(customHandshakeProtocols)
          handshakeProtocols = customHandshakeProtocols
        } else {
          handshakeProtocols = this.getSupportedHandshakeProtocols()
        }
      }

      const routing = config.routing ?? (await this.routingService.getRouting(this.agentContext, {}))

      const services = routing.endpoints.map((endpoint, index) => {
        return new OutOfBandDidCommService({
          id: `#inline-${index}`,
          serviceEndpoint: endpoint,
          recipientKeys: [routing.recipientKey].map((key) => new DidKey(key).did),
          routingKeys: routing.routingKeys.map((key) => new DidKey(key).did),
        })
      })

      const options = {
        label,
        goal: config.goal,
        goalCode: config.goalCode,
        imageUrl,
        accept: didCommProfiles,
        services,
        handshakeProtocols,
        appendedAttachments,
      }
      const outOfBandInvitation = new OutOfBandInvitation(options)

      if (messages) {
        messages.forEach((message) => {
          if (message.service) {
            // We can remove `~service` attribute from message. Newer OOB messages have `services` attribute instead.
            message.service = undefined
          }
          outOfBandInvitation.addRequest(message)
        })
      }

      outOfBandRecord = new OutOfBandRecord({
        mediatorId: routing.mediatorId,
        role: OutOfBandRole.Sender,
        state: OutOfBandState.AwaitResponse,
        alias: config.alias,
        outOfBandInvitation: outOfBandInvitation,
        reusable: multiUseInvitation,
        autoAcceptConnection,
        tags: {
          recipientKeyFingerprints: services
            .reduce<string[]>((aggr, { recipientKeys }) => [...aggr, ...recipientKeys], [])
            .map((didKey) => DidKey.fromDid(didKey).key.fingerprint),
        },
      })
    }

    await this.outOfBandService.save(this.agentContext, outOfBandRecord)
    this.outOfBandService.emitStateChangedEvent(this.agentContext, outOfBandRecord, null)

    return outOfBandRecord
  }

  /**
   * Creates an outbound out-of-band record in the same way how `createInvitation` method does it,
   * but it also converts out-of-band invitation message to an "legacy" invitation message defined
   * in RFC 0160: Connection Protocol and returns it together with out-of-band record.
   *
   * Agent role: sender (inviter)
   *
   * @param config configuration of how a connection invitation should be created
   * @returns out-of-band record and connection invitation
   */
  public async createLegacyInvitation(config: CreateLegacyInvitationConfig = {}) {
    const outOfBandRecord = await this.createInvitation({
      ...config,
      handshakeProtocols: [HandshakeProtocol.Connections],
    })
    return { outOfBandRecord, invitation: convertToOldInvitation(outOfBandRecord.getOutOfBandInvitation()) }
  }

  public async createLegacyConnectionlessInvitation<Message extends DidCommV1Message>(config: {
    /**
     * @deprecated this value is not used anymore, as the legacy connection-less exchange is now
     * integrated with the out of band protocol. The value is kept to not break the API, but will
     * be removed in a future version, and has no effect.
     */
    recordId?: string
    message: Message
    domain: string
    routing?: Routing
  }): Promise<{ message: Message; invitationUrl: string; outOfBandRecord: OutOfBandRecord }> {
    const outOfBandRecord = await this.createInvitation({
      messages: [config.message],
      routing: config.routing,
    })

    // Resolve the service and set it on the message
    const resolvedService = await this.outOfBandService.getResolvedServiceForOutOfBandServices(
      this.agentContext,
      outOfBandRecord.getOutOfBandInvitation().getServices()
    )
    config.message.service = ServiceDecorator.fromResolvedDidCommService(resolvedService)

    return {
      message: config.message,
      invitationUrl: `${config.domain}?d_m=${JsonEncoder.toBase64URL(JsonTransformer.toJSON(config.message))}`,
      outOfBandRecord,
    }
  }

  /**
   * Parses URL, decodes invitation and calls `receiveMessage` with parsed invitation message.
   *
   * Agent role: receiver (invitee)
   *
   * @param invitationUrl url containing a base64 encoded invitation to receive
   * @param config configuration of how out-of-band invitation should be processed
   * @returns out-of-band record and connection record if one has been created
   */
  public async receiveInvitationFromUrl(invitationUrl: string, config: ReceiveOutOfBandInvitationConfig = {}) {
    const message = await this.parseInvitation(invitationUrl)
    return this.receiveInvitation(message, config)
  }

  /**
   * Parses URL containing encoded invitation and returns invitation message. Compatible with
   * parsing shortened URLs
   *
   * @param invitationUrl URL containing encoded invitation
   *
   * @returns OutOfBandInvitation
   */
  public async parseInvitation(invitationUrl: string): Promise<OutOfBandInvitation | V2OutOfBandInvitation> {
    return parseInvitationShortUrl(invitationUrl, this.agentContext.config.agentDependencies)
  }

  /**
   * Creates inbound out-of-band record and assigns out-of-band invitation message to it if the
   * message is valid. It automatically passes out-of-band invitation for further processing to
   * `acceptInvitation` method. If you don't want to do that you can set `autoAcceptInvitation`
   * attribute in `config` parameter to `false` and accept the message later by calling
   * `acceptInvitation`.
   *
   * It supports both OOB (Aries RFC 0434: Out-of-Band Protocol 1.1) and Connection Invitation
   * (0160: Connection Protocol).
   *
   * Agent role: receiver (invitee)
   *
   * @param invitation either OutOfBandInvitation or ConnectionInvitationMessage
   * @param config config for handling of invitation
   *
   * @returns out-of-band record and connection record if one has been created.
   */
  public async receiveInvitation(
    invitation: OutOfBandInvitation | ConnectionInvitationMessage | V2OutOfBandInvitation,
    config: ReceiveOutOfBandInvitationConfig = {}
  ): Promise<{ outOfBandRecord: OutOfBandRecord; connectionRecord?: ConnectionRecord }> {
    return this._receiveInvitation(invitation, config)
  }

  /**
   * Creates inbound out-of-band record from an implicit invitation, given as a public DID the agent
   * should be capable of resolving. It automatically passes out-of-band invitation for further
   * processing to `acceptInvitation` method. If you don't want to do that you can set
   * `autoAcceptInvitation` attribute in `config` parameter to `false` and accept the message later by
   * calling `acceptInvitation`.
   *
   * It supports both OOB (Aries RFC 0434: Out-of-Band Protocol 1.1) and Connection Invitation
   * (0160: Connection Protocol). Handshake protocol to be used depends on handshakeProtocols
   * (DID Exchange by default)
   *
   * Agent role: receiver (invitee)
   *
   * @param config config for creating and handling invitation
   *
   * @returns out-of-band record and connection record if one has been created.
   */
  public async receiveImplicitInvitation(config: ReceiveOutOfBandImplicitInvitationConfig) {
    const invitation = new OutOfBandInvitation({
      id: config.did,
      label: config.label ?? '',
      services: [config.did],
      handshakeProtocols: config.handshakeProtocols ?? [HandshakeProtocol.DidExchange],
    })

    return this._receiveInvitation(invitation, { ...config, isImplicit: true })
  }

  /**
   * Internal receive invitation method, for both explicit and implicit OOB invitations
   */
  private async _receiveInvitation(
    invitation: OutOfBandInvitation | ConnectionInvitationMessage | V2OutOfBandInvitation,
    config: BaseReceiveOutOfBandInvitationConfig = {}
  ): Promise<{ outOfBandRecord: OutOfBandRecord; connectionRecord?: ConnectionRecord }> {
    const { routing } = config

    const autoAcceptInvitation = config.autoAcceptInvitation ?? true
    const autoAcceptConnection = config.autoAcceptConnection ?? true
    const reuseConnection = config.reuseConnection ?? false
    const label = config.label ?? this.agentContext.config.label
    const alias = config.alias
    const imageUrl = config.imageUrl ?? this.agentContext.config.connectionImageUrl

    let outOfBandRecord: OutOfBandRecord | null

    // Currently, we accept DidComm V2 invitation automatically becasue do not create record in the wallet.
    // Change it in future
    if (invitation instanceof V2OutOfBandInvitation) {
      outOfBandRecord = new OutOfBandRecord({
        role: OutOfBandRole.Receiver,
        state: OutOfBandState.Initial,
        v2OutOfBandInvitation: invitation,
        autoAcceptConnection,
      })
    } else {
      // Convert to out of band invitation if needed
      const outOfBandInvitation =
        invitation instanceof OutOfBandInvitation ? invitation : convertToNewInvitation(invitation)

      const { handshakeProtocols } = outOfBandInvitation

      const messages = outOfBandInvitation.getRequests()

      const isConnectionless = handshakeProtocols === undefined || handshakeProtocols.length === 0

      if ((!handshakeProtocols || handshakeProtocols.length === 0) && (!messages || messages?.length === 0)) {
        throw new AriesFrameworkError(
          'One or both of handshake_protocols and requests~attach MUST be included in the message.'
        )
      }

      // Make sure we haven't received this invitation before
      // It's fine if we created it (means that we are connecting to ourselves) or if it's an implicit
      // invitation (it allows to connect multiple times to the same public did)
      if (!config.isImplicit) {
        const existingOobRecordsFromThisId = await this.outOfBandService.findAllByQuery(this.agentContext, {
          invitationId: outOfBandInvitation.id,
          role: OutOfBandRole.Receiver,
        })
        if (existingOobRecordsFromThisId.length > 0) {
          throw new AriesFrameworkError(
            `An out of band record with invitation ${outOfBandInvitation.id} has already been received. Invitations should have a unique id.`
          )
        }
      }

      const recipientKeyFingerprints: string[] = []
      for (const service of outOfBandInvitation.getServices()) {
        // Resolve dids to DIDDocs to retrieve services
        if (typeof service === 'string') {
          this.logger.debug(`Resolving services for did ${service}.`)
          const resolvedDidCommServices = await this.didCommDocumentService.resolveServicesFromDid(
            this.agentContext,
            service
          )
          recipientKeyFingerprints.push(
            ...resolvedDidCommServices
              .reduce<Key[]>((aggr, { recipientKeys }) => [...aggr, ...recipientKeys], [])
              .map((key) => key.fingerprint)
          )
        } else {
          recipientKeyFingerprints.push(
            ...service.recipientKeys.map((didKey) => DidKey.fromDid(didKey).key.fingerprint)
          )
        }
      }

      outOfBandRecord = new OutOfBandRecord({
        role: OutOfBandRole.Receiver,
        state: OutOfBandState.Initial,
        outOfBandInvitation: outOfBandInvitation,
        autoAcceptConnection,
        tags: { recipientKeyFingerprints },
        mediatorId: routing?.mediatorId,
      })

      // If we have routing, and this is a connectionless exchange, or we are not auto accepting the connection
      // we need to store the routing, so it can be used when we send the first message in response to this invitation
      if (routing && (isConnectionless || !autoAcceptInvitation)) {
        this.logger.debug('Storing routing for out of band invitation.')
        outOfBandRecord.metadata.set(OutOfBandRecordMetadataKeys.RecipientRouting, {
          recipientKeyFingerprint: routing.recipientKey.fingerprint,
          routingKeyFingerprints: routing.routingKeys.map((key) => key.fingerprint),
          endpoints: routing.endpoints,
          mediatorId: routing.mediatorId,
        })
      }
    }

    if (!outOfBandRecord) {
      throw new AriesFrameworkError('Unable to receive Out-of-Band invitation.')
    }

    await this.outOfBandService.save(this.agentContext, outOfBandRecord)
    this.outOfBandService.emitStateChangedEvent(this.agentContext, outOfBandRecord, null)

    if (autoAcceptInvitation) {
      return await this.acceptInvitation(outOfBandRecord.id, {
        label,
        alias,
        imageUrl,
        autoAcceptConnection,
        reuseConnection,
        routing,
        timeoutMs: config.acceptInvitationTimeoutMs,
      })
    }

    return { outOfBandRecord }
  }

  /**
   * Creates a connection if the out-of-band invitation message contains `handshake_protocols`
   * attribute, except for the case when connection already exists and `reuseConnection` is enabled.
   *
   * It passes first supported message from `requests~attach` attribute to the agent, except for the
   * case reuse of connection is applied when it just sends `handshake-reuse` message to existing
   * connection.
   *
   * Agent role: receiver (invitee)
   *
   * @param outOfBandId
   * @param config
   * @returns out-of-band record and connection record if one has been created.
   */
  public async acceptInvitation(
    outOfBandId: string,
    config: {
      autoAcceptConnection?: boolean
      reuseConnection?: boolean
      label?: string
      alias?: string
      imageUrl?: string
      /**
       * Routing for the exchange (either connection or connection-less exchange).
       *
       * If a connection is reused, the routing WILL NOT be used.
       */
      routing?: Routing
      timeoutMs?: number
    }
  ) {
    const outOfBandRecord = await this.outOfBandService.getById(this.agentContext, outOfBandId)

    if (outOfBandRecord.v2OutOfBandInvitation) {
      const { connectionRecord } = await this.v2OutOfBandService.acceptInvitation(
        this.agentContext,
        outOfBandRecord.v2OutOfBandInvitation
      )
      return { outOfBandRecord, connectionRecord }
    }
    if (outOfBandRecord.outOfBandInvitation) {
      const { outOfBandInvitation } = outOfBandRecord
      const { label, alias, imageUrl, autoAcceptConnection, reuseConnection } = config
      const services = outOfBandInvitation.getServices()
      const messages = outOfBandInvitation.getRequests()
      const timeoutMs = config.timeoutMs ?? 20000

      let routing = config.routing

      // recipient routing from the receiveInvitation method.
      const recipientRouting = outOfBandRecord.metadata.get(OutOfBandRecordMetadataKeys.RecipientRouting)
      if (!routing && recipientRouting) {
        routing = {
          recipientKey: Key.fromFingerprint(recipientRouting.recipientKeyFingerprint),
          routingKeys: recipientRouting.routingKeyFingerprints.map((fingerprint) => Key.fromFingerprint(fingerprint)),
          endpoints: recipientRouting.endpoints,
          mediatorId: recipientRouting.mediatorId,
        }
      }

      const { handshakeProtocols } = outOfBandInvitation

      const existingConnection = await this.findExistingConnection(outOfBandInvitation)

      await this.outOfBandService.updateState(this.agentContext, outOfBandRecord, OutOfBandState.PrepareResponse)

      if (handshakeProtocols) {
        this.logger.debug('Out of band message contains handshake protocols.')

        let connectionRecord
        if (existingConnection && reuseConnection) {
          this.logger.debug(
            `Connection already exists and reuse is enabled. Reusing an existing connection with ID ${existingConnection.id}.`
          )

          if (!messages) {
            this.logger.debug('Out of band message does not contain any request messages.')
            const isHandshakeReuseSuccessful = await this.handleHandshakeReuse(outOfBandRecord, existingConnection)

            // Handshake reuse was successful
            if (isHandshakeReuseSuccessful) {
              this.logger.debug(`Handshake reuse successful. Reusing existing connection ${existingConnection.id}.`)
              connectionRecord = existingConnection
            } else {
              // Handshake reuse failed. Not setting connection record
              this.logger.debug(`Handshake reuse failed. Not using existing connection ${existingConnection.id}.`)
            }
          } else {
            // Handshake reuse because we found a connection and we can respond directly to the message
            this.logger.debug(`Reusing existing connection ${existingConnection.id}.`)
            connectionRecord = existingConnection
          }
        }

        // If no existing connection was found, reuseConnection is false, or we didn't receive a
        // handshake-reuse-accepted message we create a new connection
        if (!connectionRecord) {
          this.logger.debug('Connection does not exist or reuse is disabled. Creating a new connection.')
          // Find first supported handshake protocol preserving the order of handshake protocols
          // defined by `handshake_protocols` attribute in the invitation message
          const handshakeProtocol = this.getFirstSupportedProtocol(handshakeProtocols)
          connectionRecord = await this.connectionsApi.acceptOutOfBandInvitation(outOfBandRecord, {
            label,
            alias,
            imageUrl,
            autoAcceptConnection,
            protocol: handshakeProtocol,
            routing,
          })
        }

        if (messages) {
          this.logger.debug('Out of band message contains request messages.')
          if (connectionRecord.isReady) {
            await this.emitWithConnection(connectionRecord, messages)
          } else {
            // Wait until the connection is ready and then pass the messages to the agent for further processing
            this.connectionsApi
              .returnWhenIsConnected(connectionRecord.id, { timeoutMs })
              .then((connectionRecord) => this.emitWithConnection(connectionRecord, messages))
              .catch((error) => {
                if (error instanceof EmptyError) {
                  this.logger.warn(
                    `Agent unsubscribed before connection got into ${DidExchangeState.Completed} state`,
                    error
                  )
                } else {
                  this.logger.error('Promise waiting for the connection to be complete failed.', error)
                }
              })
          }
        }
        return { outOfBandRecord, connectionRecord }
      } else if (messages) {
        this.logger.debug('Out of band message contains only request messages.')
        if (existingConnection) {
          this.logger.debug('Connection already exists.', { connectionId: existingConnection.id })
          await this.emitWithConnection(existingConnection, messages)
        } else {
          await this.emitWithServices(services, messages)
        }
      }
    }

    return { outOfBandRecord }
  }

  public async findByReceivedInvitationId(receivedInvitationId: string) {
    return this.outOfBandService.findByReceivedInvitationId(this.agentContext, receivedInvitationId)
  }

  public async findByCreatedInvitationId(createdInvitationId: string) {
    return this.outOfBandService.findByCreatedInvitationId(this.agentContext, createdInvitationId)
  }

  /**
   * Retrieve all out of bands records
   *
   * @returns List containing all  out of band records
   */
  public getAll() {
    return this.outOfBandService.getAll(this.agentContext)
  }

  /**
   * Retrieve all out of bands records by specified query param
   *
   * @returns List containing all out of band records matching specified query params
   */
  public findAllByQuery(query: Query<OutOfBandRecord>) {
    return this.outOfBandService.findAllByQuery(this.agentContext, query)
  }

  /**
   * Retrieve a out of band record by id
   *
   * @param outOfBandId The  out of band record id
   * @throws {RecordNotFoundError} If no record is found
   * @return The out of band record
   *
   */
  public getById(outOfBandId: string): Promise<OutOfBandRecord> {
    return this.outOfBandService.getById(this.agentContext, outOfBandId)
  }

  /**
   * Find an out of band record by id
   *
   * @param outOfBandId the  out of band record id
   * @returns The out of band record or null if not found
   */
  public findById(outOfBandId: string): Promise<OutOfBandRecord | null> {
    return this.outOfBandService.findById(this.agentContext, outOfBandId)
  }

  /**
   * Delete an out of band record by id
   *
   * @param outOfBandId the out of band record id
   */
  public async deleteById(outOfBandId: string) {
    const outOfBandRecord = await this.getById(outOfBandId)

    const relatedConnections = await this.connectionsApi.findAllByOutOfBandId(outOfBandId)

    // If it uses mediation and there are no related connections, proceed to delete keys from mediator
    // Note: if OOB Record is reusable, it is safe to delete it because every connection created from
    // it will use its own recipient key
    if (outOfBandRecord.mediatorId && (relatedConnections.length === 0 || outOfBandRecord.reusable)) {
      const recipientKeys = outOfBandRecord.getTags().recipientKeyFingerprints.map((item) => Key.fromFingerprint(item))

      await this.routingService.removeRouting(this.agentContext, {
        recipientKeys,
        mediatorId: outOfBandRecord.mediatorId,
      })
    }

    return this.outOfBandService.deleteById(this.agentContext, outOfBandId)
  }

  private assertHandshakeProtocols(handshakeProtocols: HandshakeProtocol[]) {
    if (!this.areHandshakeProtocolsSupported(handshakeProtocols)) {
      const supportedProtocols = this.getSupportedHandshakeProtocols()
      throw new AriesFrameworkError(
        `Handshake protocols [${handshakeProtocols}] are not supported. Supported protocols are [${supportedProtocols}]`
      )
    }
  }

  private areHandshakeProtocolsSupported(handshakeProtocols: HandshakeProtocol[]) {
    const supportedProtocols = this.getSupportedHandshakeProtocols()
    return handshakeProtocols.every((p) => supportedProtocols.includes(p))
  }

  private getSupportedHandshakeProtocols(): HandshakeProtocol[] {
    // TODO: update to featureRegistry
    const handshakeMessageFamilies = ['https://didcomm.org/didexchange', 'https://didcomm.org/connections']
    const handshakeProtocols =
      this.messageHandlerRegistry.filterSupportedProtocolsByMessageFamilies(handshakeMessageFamilies)

    if (handshakeProtocols.length === 0) {
      throw new AriesFrameworkError('There is no handshake protocol supported. Agent can not create a connection.')
    }

    // Order protocols according to `handshakeMessageFamilies` array
    const orderedProtocols = handshakeMessageFamilies
      .map((messageFamily) => handshakeProtocols.find((p) => p.startsWith(messageFamily)))
      .filter((item): item is string => !!item)

    return orderedProtocols as HandshakeProtocol[]
  }

  private getFirstSupportedProtocol(handshakeProtocols: HandshakeProtocol[]) {
    const supportedProtocols = this.getSupportedHandshakeProtocols()
    const handshakeProtocol = handshakeProtocols.find((p) => supportedProtocols.includes(p))
    if (!handshakeProtocol) {
      throw new AriesFrameworkError(
        `Handshake protocols [${handshakeProtocols}] are not supported. Supported protocols are [${supportedProtocols}]`
      )
    }
    return handshakeProtocol
  }

  private async findExistingConnection(outOfBandInvitation: OutOfBandInvitation) {
    this.logger.debug('Searching for an existing connection for out-of-band invitation.', { outOfBandInvitation })

    for (const invitationDid of outOfBandInvitation.invitationDids) {
      const connections = await this.connectionsApi.findByInvitationDid(invitationDid)
      this.logger.debug(`Retrieved ${connections.length} connections for invitation did ${invitationDid}`)

      if (connections.length === 1) {
        const [firstConnection] = connections
        return firstConnection
      } else if (connections.length > 1) {
        this.logger.warn(
          `There is more than one connection created from invitationDid ${invitationDid}. Taking the first one.`
        )
        const [firstConnection] = connections
        return firstConnection
      }
      return null
    }
  }

  private async emitWithConnection(connectionRecord: ConnectionRecord, messages: PlaintextMessage[]) {
    const supportedMessageTypes = this.messageHandlerRegistry.supportedMessageTypes
    const plaintextMessage = messages.find((message) => {
      const parsedMessageType = parseMessageType(getPlaintextMessageType(message))
      return supportedMessageTypes.find((type) => supportsIncomingMessageType(parsedMessageType, type))
    })

    if (!plaintextMessage) {
      throw new AriesFrameworkError('There is no message in requests~attach supported by agent.')
    }

    this.logger.debug(`Message with type ${plaintextMessage['@type']} can be processed.`)

    this.eventEmitter.emit<AgentMessageReceivedEvent>(this.agentContext, {
      type: AgentEventTypes.AgentMessageReceived,
      payload: {
        message: plaintextMessage,
        connection: connectionRecord,
        contextCorrelationId: this.agentContext.contextCorrelationId,
      },
    })
  }

  private async emitWithServices(services: Array<OutOfBandDidCommService | string>, messages: PlaintextMessage[]) {
    if (!services || services.length === 0) {
      throw new AriesFrameworkError(`There are no services. We can not emit messages`)
    }

    const supportedMessageTypes = this.messageHandlerRegistry.supportedMessageTypes
    const plaintextMessage = messages.find((message) => {
      const parsedMessageType = parseMessageType(getPlaintextMessageType(message))
      return supportedMessageTypes.find((type) => supportsIncomingMessageType(parsedMessageType, type))
    })

    if (!plaintextMessage) {
      throw new AriesFrameworkError('There is no message in requests~attach supported by agent.')
    }

    this.logger.debug(`Message with type ${plaintextMessage['@type']} can be processed.`)

    this.eventEmitter.emit<AgentMessageReceivedEvent>(this.agentContext, {
      type: AgentEventTypes.AgentMessageReceived,
      payload: {
        message: plaintextMessage,
        contextCorrelationId: this.agentContext.contextCorrelationId,
      },
    })
  }

  private async handleHandshakeReuse(outOfBandRecord: OutOfBandRecord, connectionRecord: ConnectionRecord) {
    const reuseMessage = await this.outOfBandService.createHandShakeReuse(
      this.agentContext,
      outOfBandRecord,
      connectionRecord
    )

    const reuseAcceptedEventPromise = firstValueFrom(
      this.eventEmitter.observable<HandshakeReusedEvent>(OutOfBandEventTypes.HandshakeReused).pipe(
        filterContextCorrelationId(this.agentContext.contextCorrelationId),
        // Find the first reuse event where the handshake reuse accepted matches the reuse message thread
        // TODO: Should we store the reuse state? Maybe we can keep it in memory for now
        first(
          (event) =>
            event.payload.reuseThreadId === reuseMessage.threadId &&
            event.payload.outOfBandRecord.id === outOfBandRecord.id &&
            event.payload.connectionRecord.id === connectionRecord.id
        ),
        // If the event is found, we return the value true
        map(() => true),
        timeout(15000),
        // If timeout is reached, we return false
        catchError(() => of(false))
      )
    )

    const outboundMessageContext = new OutboundMessageContext(reuseMessage, {
      agentContext: this.agentContext,
      connection: connectionRecord,
    })
    await this.messageSender.sendMessage(outboundMessageContext)

    return reuseAcceptedEventPromise
  }

  // TODO: we should probably move these to the out of band module and register the handler there
  private registerMessageHandlers(messageHandlerRegistry: MessageHandlerRegistry) {
    messageHandlerRegistry.registerMessageHandler(new HandshakeReuseHandler(this.outOfBandService))
    messageHandlerRegistry.registerMessageHandler(new HandshakeReuseAcceptedHandler(this.outOfBandService))
  }
}
