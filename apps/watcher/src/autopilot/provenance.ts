import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { repoPath, stableStringify, writeJson } from "./common";
import { loadPolicy } from "./policy";
import type {
  ProvenanceAttestation,
  ProvenanceManifest,
  ProvenanceManifestFile,
  ProvenanceSignature
} from "./types";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function escapeRegex(raw: string): string {
  return raw.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  let pattern = normalizePath(glob);
  pattern = escapeRegex(pattern);
  pattern = pattern.replace(/\*\*/g, "__DOUBLE_STAR__");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${pattern}$`);
}

async function walkFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const childPath = normalizePath(`${path}/${entry.name}`);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(childPath)));
    } else if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files;
}

function globBase(glob: string): string {
  const normalized = normalizePath(glob);
  const wildcardIndex = normalized.search(/[*]/);
  if (wildcardIndex === -1) return normalized;
  const prefix = normalized.slice(0, wildcardIndex);
  const slashIndex = prefix.lastIndexOf("/");
  return slashIndex === -1 ? "." : prefix.slice(0, slashIndex);
}

async function collectFiles(globs: string[]): Promise<string[]> {
  const matched = new Set<string>();
  for (const glob of globs) {
    const resolvedGlob = isAbsolute(glob) ? glob : repoPath(glob);
    const base = globBase(resolvedGlob);
    try {
      const files = await walkFiles(base);
      const regex = globToRegex(resolvedGlob);
      for (const file of files) {
        if (regex.test(file)) matched.add(file);
      }
    } catch {
      // ignore missing directories
    }
  }
  return [...matched].sort((a, b) => a.localeCompare(b));
}

async function hashFile(path: string): Promise<string> {
  const raw = await readFile(path);
  const hash = createHash("sha256").update(raw).digest("hex");
  return `sha256:${hash}`;
}

async function buildFileManifest(paths: string[]): Promise<ProvenanceManifestFile[]> {
  const files: ProvenanceManifestFile[] = [];
  for (const path of paths) {
    const raw = await readFile(path);
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    files.push({
      path: normalizePath(path),
      digest,
      size: raw.byteLength
    });
  }
  return files;
}

function hashManifestFiles(files: ProvenanceManifestFile[]): string {
  const payload = files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}:${file.digest}:${file.size}`)
    .join("\n");
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function parsePem(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function signaturePayload(manifest: ProvenanceManifest, attestation: ProvenanceAttestation): string {
  return stableStringify({
    manifest,
    attestation
  });
}

export async function generateProvenanceBundle(): Promise<{
  manifest: ProvenanceManifest;
  attestation: ProvenanceAttestation;
  signature?: ProvenanceSignature;
}> {
  const policy = await loadPolicy();
  const files = await collectFiles(policy.provenance.artifact_paths);
  const manifestFiles = await buildFileManifest(files);
  const artifactDigest = hashManifestFiles(manifestFiles);
  const lockfileDigest = await hashFile(repoPath("pnpm-lock.yaml")).catch(() => "sha256:missing");

  const commitSha = process.env.AUTOPILOT_COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim() || "unknown";
  const policyVersion = process.env.AUTOPILOT_POLICY_VERSION?.trim() || String(policy.version);
  const modelId = process.env.AUTOPILOT_MODEL_ID?.trim() || "unspecified";
  const buildTimestamp = new Date().toISOString();

  const manifest: ProvenanceManifest = {
    schemaVersion: 1,
    artifactName: process.env.AUTOPILOT_ARTIFACT_NAME?.trim() || "watcher-agent-bundle",
    artifactDigest,
    files: manifestFiles,
    commitSha,
    lockfileDigest,
    buildTimestamp,
    policyVersion,
    modelId
  };

  const attestation: ProvenanceAttestation = {
    schemaVersion: 1,
    predicateType: "https://slsa.dev/provenance/v1",
    subjectDigest: artifactDigest,
    predicate: {
      commitSha,
      policyVersion,
      modelId,
      generatedAt: buildTimestamp
    }
  };

  const manifestPath = isAbsolute(policy.provenance.manifest_path)
    ? policy.provenance.manifest_path
    : repoPath(policy.provenance.manifest_path);
  const attestationPath = isAbsolute(policy.provenance.attestation_path)
    ? policy.provenance.attestation_path
    : repoPath(policy.provenance.attestation_path);
  const signaturePath = isAbsolute(policy.provenance.signature_path)
    ? policy.provenance.signature_path
    : repoPath(policy.provenance.signature_path);

  await writeJson(manifestPath, manifest);
  await writeJson(attestationPath, attestation);

  const privateKeyPem = process.env.AUTOPILOT_SIGNING_PRIVATE_KEY_PEM?.trim();
  let signature: ProvenanceSignature | undefined;
  if (privateKeyPem) {
    const payload = signaturePayload(manifest, attestation);
    const key = createPrivateKey(parsePem(privateKeyPem));
    const sig = sign(null, Buffer.from(payload), key).toString("base64");
    signature = {
      algorithm: "ed25519",
      keyId: process.env.AUTOPILOT_SIGNING_KEY_ID?.trim() || basename(signaturePath),
      signatureBase64: sig
    };
    await writeJson(signaturePath, signature);
  }

  return { manifest, attestation, signature };
}

export async function verifyProvenanceBundle(options?: {
  requireSignature?: boolean;
}): Promise<{ ok: boolean; reasons: string[] }> {
  const policy = await loadPolicy();
  const reasons: string[] = [];
  const manifestPath = isAbsolute(policy.provenance.manifest_path)
    ? policy.provenance.manifest_path
    : repoPath(policy.provenance.manifest_path);
  const attestationPath = isAbsolute(policy.provenance.attestation_path)
    ? policy.provenance.attestation_path
    : repoPath(policy.provenance.attestation_path);
  const signaturePath = isAbsolute(policy.provenance.signature_path)
    ? policy.provenance.signature_path
    : repoPath(policy.provenance.signature_path);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProvenanceManifest;
  const attestation = JSON.parse(await readFile(attestationPath, "utf8")) as ProvenanceAttestation;

  const expectedCommit = process.env.AUTOPILOT_EXPECTED_COMMIT_SHA?.trim();
  if (expectedCommit && manifest.commitSha !== expectedCommit) {
    reasons.push(`Commit SHA mismatch. expected=${expectedCommit} got=${manifest.commitSha}`);
  }

  const recomputedManifestFiles: ProvenanceManifestFile[] = [];
  for (const file of manifest.files) {
    const digest = await hashFile(file.path).catch(() => "sha256:missing");
    if (digest !== file.digest) {
      reasons.push(`Digest mismatch for ${file.path}`);
    }
    recomputedManifestFiles.push({ ...file, digest });
  }

  const recomputedArtifactDigest = hashManifestFiles(recomputedManifestFiles);
  if (recomputedArtifactDigest !== manifest.artifactDigest) {
    reasons.push(
      `Artifact digest mismatch. expected=${manifest.artifactDigest} computed=${recomputedArtifactDigest}`
    );
  }
  if (attestation.subjectDigest !== manifest.artifactDigest) {
    reasons.push(
      `Attestation subject mismatch. subject=${attestation.subjectDigest} manifest=${manifest.artifactDigest}`
    );
  }

  const requireSignature =
    options?.requireSignature ??
    parseBoolean(process.env.AUTOPILOT_PROVENANCE_REQUIRE_SIGNATURE?.trim(), false);
  const publicKeyPem = process.env.AUTOPILOT_SIGNING_PUBLIC_KEY_PEM?.trim();
  const shouldVerifySignature = Boolean(publicKeyPem) || requireSignature;
  if (shouldVerifySignature && !publicKeyPem) {
    reasons.push("Signature verification required but AUTOPILOT_SIGNING_PUBLIC_KEY_PEM is not configured");
  }

  if (shouldVerifySignature && publicKeyPem) {
    let signature: ProvenanceSignature | undefined;
    try {
      signature = JSON.parse(await readFile(signaturePath, "utf8")) as ProvenanceSignature;
    } catch {
      signature = undefined;
    }
    if (!signature) {
      reasons.push(`Signature verification required but signature file is missing: ${signaturePath}`);
      return {
        ok: reasons.length === 0,
        reasons
      };
    }

    const payload = signaturePayload(manifest, attestation);
    const key = createPublicKey(parsePem(publicKeyPem));
    const valid = verify(null, Buffer.from(payload), key, Buffer.from(signature.signatureBase64, "base64"));
    if (!valid) reasons.push("Signature verification failed");
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2]?.trim() || "verify";
  if (mode === "generate") {
    const bundle = await generateProvenanceBundle();
    console.log(
      `[autopilot:provenance] generated manifest=${bundle.manifest.artifactDigest} signed=${Boolean(bundle.signature)}`
    );
    return;
  }

  if (mode !== "verify") {
    throw new Error(`Unknown provenance mode: ${mode}. Expected generate|verify`);
  }

  const result = await verifyProvenanceBundle();
  console.log(`[autopilot:provenance] verify ok=${result.ok}`);
  for (const reason of result.reasons) {
    console.log(`- ${reason}`);
  }
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
