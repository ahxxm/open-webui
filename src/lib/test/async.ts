export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(25);
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
