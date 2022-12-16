import { DidCommV1Message, IsValidMessageType, parseMessageType } from '@aries-framework/core'
import { IsOptional, IsString } from 'class-validator'

/**
 * @internal
 */
export interface PerformMessageOptions {
  id?: string
  name: string
  params?: Record<string, string>
  threadId: string
}

/**
 * @internal
 */
export class PerformMessage extends DidCommV1Message {
  public constructor(options: PerformMessageOptions) {
    super()

    if (options) {
      this.id = options.id ?? this.generateId()
      this.name = options.name
      this.params = options.params
      this.setThread({
        threadId: options.threadId,
      })
    }
  }

  @IsValidMessageType(PerformMessage.type)
  public readonly type = PerformMessage.type.messageTypeUri
  public static readonly type = parseMessageType('https://didcomm.org/action-menu/1.0/perform')

  @IsString()
  public name!: string

  @IsString({ each: true })
  @IsOptional()
  public params?: Record<string, string>
}
