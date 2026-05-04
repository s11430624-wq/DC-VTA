const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..');
const internalDashboardDir = path.resolve(workspaceRoot, 'apps', 'dashboard');
const externalDashboardDir = process.env.EXTERNAL_DASHBOARD_DIR || 'C:\\Users\\s9207\\teacher-dashboard';

const EXCLUDED_NAMES = new Set([
    'node_modules',
    'dist',
    '.git',
    '.DS_Store',
]);

const EXCLUDED_FILES = new Set([
    '.env',
    '.env.local',
]);

function ensureDirectoryExists(dirPath, label) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        throw new Error(`${label} 不存在或不是資料夾: ${dirPath}`);
    }
}

function removeContents(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (EXCLUDED_NAMES.has(entry.name) || EXCLUDED_FILES.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
    }
}

function copyRecursive(sourceDir, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const entryName = entry.name;
        if (EXCLUDED_NAMES.has(entryName)) {
            continue;
        }
        if (entry.isFile() && EXCLUDED_FILES.has(entryName)) {
            continue;
        }

        const sourcePath = path.join(sourceDir, entryName);
        const targetPath = path.join(targetDir, entryName);

        if (entry.isDirectory()) {
            copyRecursive(sourcePath, targetPath);
            continue;
        }

        if (entry.isSymbolicLink()) {
            continue;
        }

        fs.copyFileSync(sourcePath, targetPath);
    }
}

function main() {
    const direction = process.argv[2];
    if (direction !== 'out' && direction !== 'in') {
        throw new Error('用法: node scripts/sync_dashboard.cjs <out|in>');
    }

    ensureDirectoryExists(internalDashboardDir, '內部 dashboard');
    ensureDirectoryExists(externalDashboardDir, '外部 dashboard');

    if (direction === 'in' && process.env.ALLOW_DASHBOARD_SYNC_IN !== 'true') {
        throw new Error(
            '為了避免誤覆蓋，sync-in 需要設定 ALLOW_DASHBOARD_SYNC_IN=true 才能執行。',
        );
    }

    const sourceDir = direction === 'out' ? internalDashboardDir : externalDashboardDir;
    const targetDir = direction === 'out' ? externalDashboardDir : internalDashboardDir;

    console.log(`Sync direction: ${direction}`);
    console.log(`Source: ${sourceDir}`);
    console.log(`Target: ${targetDir}`);

    removeContents(targetDir);
    copyRecursive(sourceDir, targetDir);

    console.log('✅ Dashboard 同步完成');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
