import { spawn, type ChildProcess } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';

const PORT = 8081;
const TMP_ROOT = '/tmp/slim-test';
const DATA_DIR = `${TMP_ROOT}/data`;

let server: ChildProcess | null = null;
let refs = 0;

// Browser mode creates two projects (core workspace + browser) and both
// inherit this globalSetup, so setup/teardown each run twice. Share one
// backend and only kill it when the last consumer tears down.
// process.on('exit') covers runs that die before teardown (hard crash).
process.on('exit', () => {
	server?.kill('SIGTERM');
});

async function waitForReady(url: string, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Backend not ready after ${timeoutMs}ms`);
}

export async function setup() {
	if (server) {
		refs++;
		return;
	}
	refs = 1;

	await rm(TMP_ROOT, { recursive: true, force: true });
	await mkdir(DATA_DIR, { recursive: true });

	server = spawn('uv', ['run', 'hypercorn', 'open_webui.main:app', '--bind', `0.0.0.0:${PORT}`], {
		cwd: 'backend',
		env: {
			...process.env,
			DATA_DIR,
			WEBUI_AUTH: 'false',
			CORS_ALLOW_ORIGIN: '*'
		},
		stdio: ['ignore', 'ignore', 'pipe']
	});

	server.stderr?.on('data', (chunk: Buffer) => {
		const line = chunk.toString();
		if (line.includes('ERROR') || line.includes('Traceback')) {
			process.stderr.write(`[backend] ${line}`);
		}
	});

	await waitForReady(`http://localhost:${PORT}/health`);
}

export async function teardown() {
	if (server && --refs > 0) return;
	if (server) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => {
			server!.on('close', resolve);
			setTimeout(resolve, 3000);
		});
		server = null;
	}
	await rm(TMP_ROOT, { recursive: true, force: true });
}
