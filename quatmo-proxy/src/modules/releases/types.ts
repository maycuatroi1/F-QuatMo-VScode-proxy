export type UpdateType = "installer" | "patch" | "extension" | "policy";

export interface ReleaseManifest {
  /** Target software version (semver compliant). */
  version: string;
  /** Git commit hash corresponding to the release artifact. */
  commit: string;
  /** Distribution channel classification. */
  updateType?: UpdateType;
  /** Human-readable release display name. */
  name?: string;
  /** Product branding version string. */
  productVersion?: string;
  /** Primary artifact file name. */
  filename?: string;
  /** Object storage key within the releases bucket prefix. */
  s3Key?: string;
  /** Fully-qualified public or proxy-routed artifact download URL. */
  downloadUrl: string;
  /** Optional high-speed CDN or LAN mirror download URL to offload bandwidth from proxy. */
  cdnUrl?: string;
  /** Cryptographic SHA-256 hexadecimal checksum. */
  sha256hash?: string;
  /** SHA-256 of <appRoot>/out/main.js for installer/patch builds (client build checksum). */
  buildHash?: string;
  /** Binary file size in bytes. */
  sizeBytes?: number;
  /** Binary file size in megabytes. */
  sizeMB?: number;
  /** Release changelog or operational notes. */
  notes?: string;
  /** ISO-8601 release timestamp. */
  releasedAt: string;
  /** Enforces mandatory update application prior to workbench execution. */
  mandatory?: boolean;
  /** Target extension identifier when `updateType` is 'extension'. */
  targetExtensionId?: string;
  /** Specific extension version when `updateType` is 'extension'. */
  extensionVersion?: string;
  /** Remote policy payload when `updateType` is 'policy'. */
  policyConfig?: Record<string, any>;
  /** "ed25519:<base64>" publisher signature (scripts/release-signing.mjs). */
  signature?: string;
}
