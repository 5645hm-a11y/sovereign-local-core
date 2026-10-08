# Password-protected identity vault

The current project encryption/permission protocol is described in
[CRYPTO_RBAC.md](CRYPTO_RBAC.md). Identity vaults retain their version-1 envelope;
event logs use encrypted, authorized schema version 3. New event signatures cover
canonical binary bytes, and event storage/transport use binary envelopes. Vault
credentials, vault encryption and saved vault bytes retain their existing JSON
format for compatibility; only event production/replay changed.

## Algorithms

| Purpose | Native Web Crypto algorithm |
| --- | --- |
| Vault key derivation | PBKDF2-HMAC-SHA-256, 600,000 iterations, random 16-byte salt |
| Vault encryption | AES-GCM-256, random 12-byte IV, 128-bit tag |
| Random identity | P-256 key pair |
| Signatures | ECDSA/SHA-256, 64-byte P1363 `r || s`, canonical base64url |
| ActorID | `p256_` plus base64url of the full 65-byte uncompressed public point |

Email is trimmed, NFC-normalized and lowercased as a local identifier, not verified
by a mail service. Passwords contain 12–1024 JavaScript string code units and are not
trimmed/normalized. PBKDF2 receives the UTF-8 JSON tuple
`["sovereign-local-core/credentials/v1", normalizedEmail, password]`.

The AES key is non-extractable. It opens a random signing identity rather than
deterministically deriving that identity from credentials. Two fresh vaults created
with identical credentials still contain different keys; unlocking one saved vault
restores its same ActorID.

The envelope contains exactly `version: 1`, `kdf: "PBKDF2-SHA-256"`,
`iterations: 600000`, `salt`, `iv`, and `ciphertext`. AES-GCM AAD is UTF-8 JSON of
`["sovereign-local-core/vault/v1", normalizedEmail, version, kdf, iterations, salt, iv]`.
The encrypted content contains version 1, the base64url PKCS8 private key, and raw
public key. Unsupported parameters/oversized ciphertext fail format validation.
Wrong credentials or tampered ciphertext throw `IdentityUnlockError`.

The generated pair is briefly exportable during vault construction, then imported
as non-extractable ECDSA signing/verification handles. Unlock signs/verifies a
domain-separated challenge to check private/public key agreement. The same private
scalar is additionally imported as a non-extractable ECDH handle for wrapping project
keys to ActorID; see the explicit design tradeoff in the project protocol.

## Persistence and Worker isolation

The default filename is
`sovereign-identity-vaults/account_<base64url SHA-256(normalizedEmail)>.slv`.
This hash is a locator, not secret encryption. An explicit `vaultName` isolates
identities in demos. A Web Lock serializes vault creation/unlock. Only encrypted
vault bytes are written using the CRC-framed log, with immediate flush before any
project log refers to the identity. Existing vaults are never silently replaced on
incorrect credentials; their file handles close after unlock.

Normal `LocalCoreClient` APIs return only public identity/project metadata, snapshots
and ciphertext events. The Dedicated Worker retains keys until close/termination.
Lower-level `createIdentityVault` / `unlockIdentityVault` return key handles for custom
integrations. Owned byte buffers are cleared where practical; JS string/key zeroization
cannot be guaranteed. Same-origin application code can still invoke authorized
signing/decryption operations through its own running client.

A separate Web Lock prevents two local writers for the same actor/project even if
they use different database filenames. Independently cloning one identity into two
browser profiles/devices can reuse sequence IDs; that workflow still requires a
device-actor design.

## Recovery and tests

Credentials alone cannot reconstruct random identity keys after site data deletion.
Backup the encrypted vault, recipient-encrypted project metadata, and event log.
Forgotten-password recovery and password-change APIs are not implemented.

`tests/browser/identity.spec.mjs` proves distinct random identities, stable unlock,
non-extractable private keys, wrong-credential/tamper rejection, public-only Worker
results, Alice/Bob impersonation rejection, signed-field/duplicate verification,
reload recovery, and forged-OPFS preservation before tail repair. The tests now use
actual project certificates and encrypted events. Run `npm test` and
`npm run test:browser`.

## References

- [Web Crypto deriveKey](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)
- [ECDSA signing and P1363 encoding](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign)
- [AES-GCM parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)
- [OWASP PBKDF2 work-factor guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

The 600,000 PBKDF2-HMAC-SHA-256 work factor retains native browser support and follows
OWASP's PBKDF2 guidance; this is not a claim of FIPS certification.
