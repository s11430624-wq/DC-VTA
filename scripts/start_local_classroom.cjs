const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const net = require('net');

const workspaceRoot = path.resolve(__dirname, '..');
const botDir = path.resolve(workspaceRoot, 'apps', 'bot');
const dashboardDirDefault = path.resolve(workspaceRoot, 'apps', 'dashboard');
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm' : 'npm';
const nodeCommand = process.execPath;

const dashboardHost = process.env.LOCAL_DASHBOARD_HOST || '127.0.0.1';
const dashboardPort = Number(process.env.LOCAL_DASHBOARD_PORT || 5173);
const aiGradingHost = process.env.LOCAL_AI_GRADING_HOST || '127.0.0.1';
const aiGradingPort = Number(process.env.LOCAL_AI_GRADING_PORT || 8787);

function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const result = {};
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        result[key] = value;
    }

    return result;
}

function buildRuntimeEnv(overrides = {}) {
    return {
        ...parseEnvFile(path.resolve(botDir, '.env')),
        ...process.env,
        ...overrides,
    };
}

function resolveDashboardDir() {
    const candidates = [
        process.env.LOCAL_DASHBOARD_DIR,
        dashboardDirDefault,
        'C:\\Users\\s9207\\teacher-dashboard',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `找不到 teacher-dashboard 專案。請設定 LOCAL_DASHBOARD_DIR。目前嘗試路徑：${candidates.join(', ')}`,
    );
}

function spawnProcess(label, command, args, options) {
    const child = spawn(command, args, {
        stdio: 'inherit',
        ...options,
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            console.log(`ℹ️ ${label} 已結束，signal=${signal}`);
            return;
        }

        console.log(`ℹ️ ${label} 已結束，code=${code}`);
    });

    return child;
}

function spawnNpmProcess(label, args, options) {
    if (isWindows) {
        const commandLine = ['npm', ...args].join(' ');
        return spawnProcess(label, 'cmd.exe', ['/d', '/s', '/c', commandLine], options);
    }

    return spawnProcess(label, npmCommand, args, options);
}

function isPortInUse(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        const done = (inUse) => {
            socket.destroy();
            resolve(inUse);
        };

        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

function killProcessTree(pid) {
    if (!pid) {
        return;
    }

    if (isWindows) {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
        return;
    }

    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // ignore
        }
    }
}

async function main() {
    const dashboardDir = resolveDashboardDir();
    const dashboardUrl = `http://${dashboardHost}:${dashboardPort}`;
    const aiGradingUrl = `http://${aiGradingHost}:${aiGradingPort}/api/ai-grade`;
    const botEnv = buildRuntimeEnv({
        FRONTEND_BASE_URL: dashboardUrl,
        LOCAL_DASHBOARD_DIR: dashboardDir,
    });

    console.log(`📍 Dashboard dir: ${dashboardDir}`);
    console.log(`📍 Bot dir: ${botDir}`);
    console.log(`📍 Dashboard URL: ${dashboardUrl}`);
    console.log(`📍 Local AI grading URL: ${aiGradingUrl}`);

    const children = [];

    const aiPortInUse = await isPortInUse(aiGradingHost, aiGradingPort);
    if (aiPortInUse) {
        console.log(`ℹ️ 偵測到 ${aiGradingHost}:${aiGradingPort} 已在使用中，沿用既有 AI grading 服務。`);
    } else {
        const aiServer = spawnProcess(
            'Local AI grading server',
            nodeCommand,
            [path.resolve(workspaceRoot, 'scripts', 'local_ai_grading_server.cjs')],
            {
                cwd: workspaceRoot,
                env: buildRuntimeEnv({
                    LOCAL_AI_GRADING_HOST: aiGradingHost,
                    LOCAL_AI_GRADING_PORT: String(aiGradingPort),
                }),
            },
        );
        children.push(aiServer);
    }

    const dashboardPortInUse = await isPortInUse(dashboardHost, dashboardPort);
    if (dashboardPortInUse) {
        console.log(`ℹ️ 偵測到 ${dashboardHost}:${dashboardPort} 已在使用中，沿用既有 dashboard。`);
    } else {
        const dashboard = spawnNpmProcess(
            'Teacher dashboard',
            ['run', 'dev', '--', '--host', dashboardHost, '--port', String(dashboardPort), '--strictPort'],
            {
                cwd: dashboardDir,
                env: {
                    ...botEnv,
                    VITE_AI_GRADING_API_URL: aiGradingUrl,
                },
            },
        );
        children.push(dashboard);
    }

    const bot = spawnNpmProcess(
        'Discord bot',
        ['run', 'start'],
        {
            cwd: botDir,
            env: botEnv,
        },
    );
    children.push(bot);

    const shutdown = () => {
        console.log('⏹️ 正在關閉 classroom 本機模式...');
        for (const child of children) {
            killProcessTree(child.pid);
        }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`❌ 啟動 classroom 模式失敗：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}

module.exports = {
    resolveDashboardDir,
};
