/**
 * Public surface of the secure-store module.
 *
 * Issue #690 (PR 1/4) — pure encryption primitives only. No storage
 * integration, no CLI, no daemon lock state. Subsequent PRs add:
 *
 *   - PR 2/4: `remnic secure-store {init,lock,unlock,status}` CLI.
 *   - PR 3/4: transparent storage.ts wrapping + migration.
 *   - PR 4/4: capsule export `--encrypt`, encrypted backups, docs.
 *
 * Naming: `secure-store` (NOT `vault`) intentionally avoids
 * collision with `ObsidianVaultState` / `vaultId` / `obsidianVaults`
 * in `native-knowledge.ts`. See `kdf.ts` header for details.
 */

export {
  AES_KEY_LENGTH,
  AUTH_TAG_LENGTH,
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_LAYOUT,
  ENVELOPE_SALT_LENGTH,
  ENVELOPE_VERSION,
  IV_LENGTH,
  generateSalt,
  open,
  parseEnvelope,
  seal,
  type DecryptOptions,
  type EncryptOptions,
  type ParsedEnvelope,
} from "./cipher.js";

export {
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  KDF_KEY_LENGTH,
  KDF_SALT_LENGTH,
  constantTimeEqual,
  deriveKey,
  deriveKeyScrypt,
  validateScryptParams,
  type Argon2idParams,
  type KdfAlgorithm,
  type ScryptParams,
} from "./kdf.js";

export {
  METADATA_FORMAT,
  METADATA_FORMAT_VERSION,
  buildMetadata,
  decodeMetadataSalt,
  parseMetadata,
  serializeMetadata,
  validateMetadata,
  type BuildMetadataOptions,
  type SecureStoreMetadata,
  type SecureStoreMetadataKdf,
  type SecureStoreMetadataKdfArgon2id,
  type SecureStoreMetadataKdfScrypt,
} from "./metadata.js";

// Issue #690 PR 2/4 — header (metadata + verifier) and CLI surface.
export {
  HEADER_FILENAME,
  HEADER_FORMAT,
  HEADER_FORMAT_VERSION,
  SECURE_STORE_DIR_NAME,
  buildHeader,
  buildHeaderFromPassphrase,
  deriveKeyFromHeader,
  headerPath,
  parseHeader,
  readHeader,
  secureStoreDir,
  serializeHeader,
  validateHeader,
  verifyKey,
  writeHeader,
  type SecureStoreHeader,
} from "./header.js";

export * as keyring from "./keyring.js";

export {
  MIN_PASSPHRASE_LENGTH,
  runSecureStoreInit,
  runSecureStoreLock,
  runSecureStoreStatus,
  runSecureStoreUnlock,
  type PassphraseReader,
  type SecureStoreInitOptions,
  type SecureStoreInitReport,
  type SecureStoreLockOptions,
  type SecureStoreLockReport,
  type SecureStoreStatusOptions,
  type SecureStoreStatusReport,
  type SecureStoreUnlockOptions,
  type SecureStoreUnlockReport,
} from "./cli-handlers.js";

export {
  renderInitReport,
  renderLockReport,
  renderStatusReport,
  renderUnlockReport,
} from "./cli-renderer.js";

export { createPassphraseReader } from "./passphrase-reader.js";

// Issue #690 PR 3/4 — transparent storage wrapping + migration.
export {
  ENCRYPTED_FILE_HEADER_SIZE,
  ENCRYPTED_FILE_LAYOUT,
  ENCRYPTED_FILE_MAGIC,
  ENCRYPTED_FILE_MAGIC_LENGTH,
  ENCRYPTED_FILE_RESERVED_LENGTH,
  ENCRYPTED_FILE_VERSION,
  SecureStoreDecryptError,
  SecureStoreLockedError,
  decryptFileBody,
  encryptFileBody,
  isEncryptedFile,
  migrateMemoryDirToEncrypted,
  readMaybeEncryptedFile,
  writeMaybeEncryptedFile,
  type MigrateMemoryDirOptions,
  type SecureFsMigrationReport,
  type SecureFsOptions,
  type SecureFsSnapshotFn,
} from "./secure-fs.js";
