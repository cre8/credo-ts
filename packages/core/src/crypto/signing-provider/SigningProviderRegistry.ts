import type { SigningProvider } from './SigningProvider'
import type { KeyType } from '..'

import { AriesFrameworkError } from '../../error'
import { injectable, injectAll } from '../../plugins'

export const SigningProviderToken = Symbol('SigningProviderToken')

@injectable()
export class SigningProviderRegistry {
  public signingProviders: SigningProvider[]

  public constructor(@injectAll(SigningProviderToken) signingProviders: Array<'default' | SigningProvider>) {
    // This is a really ugly hack to make tsyringe work without any SigningProviders registered
    // It is currently impossible to use @injectAll if there are no instances registered for the
    // token. We register a value of `default` by default and will filter that out in the registry.
    // Once we have a signing provider that should always be registered we can remove this. We can make an ed25519
    // signer using the @stablelib/ed25519 library.
    this.signingProviders = signingProviders.filter((provider) => provider !== 'default') as SigningProvider[]
  }

  public hasProviderForKeyType(keyType: KeyType): boolean {
    const signingKeyProvider = this.signingProviders.find((x) => x.keyType === keyType)

    return signingKeyProvider !== undefined
  }

  public getProviderForKeyType(keyType: KeyType): SigningProvider {
    const signingKeyProvider = this.signingProviders.find((x) => x.keyType === keyType)

    if (!signingKeyProvider) {
      throw new AriesFrameworkError(`No key provider for key type: ${keyType}`)
    }

    return signingKeyProvider
  }

  public get supportedKeyTypes(): KeyType[] {
    return Array.from(new Set(this.signingProviders.map((provider) => provider.keyType)))
  }
}
