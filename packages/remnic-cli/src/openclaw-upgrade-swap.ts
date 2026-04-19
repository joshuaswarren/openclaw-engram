import fs from "node:fs";
import path from "node:path";

export interface PreparedDirectorySwap {
  rollbackDir?: string;
}

export interface RollbackOpenclawUpgradeOptions {
  configBackupPath?: string;
  configPath: string;
  pluginBackupDir?: string;
  pluginDir: string;
  rollbackDir?: string;
}

export interface BestEffortGatewayRestartResult {
  message: string;
  restarted: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function swapDirectoryWithRollback(
  stagedDir: string,
  targetDir: string,
  rollbackDir: string,
): PreparedDirectorySwap {
  let hasRollbackCopy = false;

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.rmSync(rollbackDir, { recursive: true, force: true });
  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, rollbackDir);
    hasRollbackCopy = true;
  }

  try {
    fs.renameSync(stagedDir, targetDir);
  } catch (swapError) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    if (hasRollbackCopy && fs.existsSync(rollbackDir)) {
      try {
        fs.renameSync(rollbackDir, targetDir);
        hasRollbackCopy = false;
      } catch (restoreError) {
        throw new AggregateError(
          [swapError, restoreError],
          `Failed to stage upgraded plugin and failed to restore the previous plugin copy. ` +
          `The last known-good plugin remains preserved at ${rollbackDir}.`,
        );
      }
    }
    throw swapError;
  }

  return { rollbackDir: hasRollbackCopy ? rollbackDir : undefined };
}

export function cleanupRollbackDirectory(rollbackDir?: string): void {
  if (!rollbackDir) return;
  fs.rmSync(rollbackDir, { recursive: true, force: true });
}

export function cleanupRollbackDirectoryBestEffort(rollbackDir?: string): string | undefined {
  if (!rollbackDir) return undefined;

  try {
    cleanupRollbackDirectory(rollbackDir);
    return undefined;
  } catch (error) {
    return (
      `Warning: the upgrade completed, but failed to remove the preserved rollback copy at ` +
      `${rollbackDir}: ${describeError(error)}`
    );
  }
}

export function restoreDirectoryFromRollback(targetDir: string, rollbackDir: string): void {
  if (!fs.existsSync(rollbackDir)) {
    throw new Error(`Rollback directory is missing: ${rollbackDir}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  try {
    fs.renameSync(rollbackDir, targetDir);
  } catch (restoreError) {
    throw new Error(
      `Failed to restore the previous plugin copy into ${targetDir}. ` +
      `The last known-good plugin remains preserved at ${rollbackDir}.`,
      { cause: restoreError },
    );
  }
}

function restoreDirectoryFromBackup(targetDir: string, backupDir: string): void {
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Plugin backup directory is missing: ${backupDir}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(backupDir, targetDir, { recursive: true });
}

function restoreFileFromBackup(targetPath: string, backupPath: string): void {
  if (!fs.existsSync(backupPath)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(backupPath, targetPath);
}

export function rollbackOpenclawUpgrade({
  configBackupPath,
  configPath,
  pluginBackupDir,
  pluginDir,
  rollbackDir,
}: RollbackOpenclawUpgradeOptions): string[] {
  const notes: string[] = [];
  const errors: string[] = [];

  try {
    if (rollbackDir && fs.existsSync(rollbackDir)) {
      restoreDirectoryFromRollback(pluginDir, rollbackDir);
      notes.push(`Restored previous plugin from rollback copy at ${rollbackDir}`);
    } else if (pluginBackupDir && fs.existsSync(pluginBackupDir)) {
      restoreDirectoryFromBackup(pluginDir, pluginBackupDir);
      notes.push(`Restored previous plugin from backup at ${pluginBackupDir}`);
    } else {
      notes.push("No previous plugin copy was available for automatic restore");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    if (configBackupPath && fs.existsSync(configBackupPath)) {
      restoreFileFromBackup(configPath, configBackupPath);
      notes.push(`Restored OpenClaw config from backup at ${configBackupPath}`);
    }
  } catch (error) {
    errors.push(
      `Failed to restore OpenClaw config from backup at ${configBackupPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  return notes;
}

export function createOpenclawUpgradeRollbackFailure(options: {
  failurePhase: string;
  installError: unknown;
  rollbackError: unknown;
}): AggregateError {
  const { failurePhase, installError, rollbackError } = options;
  return new AggregateError(
    [installError, rollbackError],
    `OpenClaw upgrade failed while ${failurePhase}. ` +
    `Automatic rollback also failed: ${describeError(rollbackError)}. ` +
    `Original upgrade failure: ${describeError(installError)}.`,
  );
}

export function runBestEffortGatewayRestart(
  restartGateway: () => void,
  gatewayLabel: string,
): BestEffortGatewayRestartResult {
  try {
    restartGateway();
    return {
      message: `Restarted OpenClaw gateway via launchctl kickstart (${gatewayLabel}).`,
      restarted: true,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      message:
        `Warning: the upgrade completed, but the automatic OpenClaw gateway restart failed: ${reason}\n` +
        "Run this manually when you're ready:\n" +
        `  launchctl kickstart -k gui/$(id -u)/${gatewayLabel}`,
      restarted: false,
    };
  }
}
