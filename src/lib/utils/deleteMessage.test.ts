/**
 * Unit tests for the pure deleteMessage(history, messageId) — covers tree
 * shapes the slow integration test does not.
 *
 * Contract:
 * - deleting a message removes it and its whole subtree
 * - the parent no longer references the deleted branch, surviving siblings
 *   and their order are untouched
 * - currentId outside the subtree is preserved; inside the subtree it falls
 *   back to the latest-timestamp surviving message (same rule as the
 *   load-time dangling-currentId recovery in Chat.svelte)
 */
import { describe, it, expect, vi } from 'vitest';

// $lib/utils pulls in constants.ts which touches location when browser=true,
// and builds a drag-ghost Image at module load; both are browser globals
vi.mock('$app/environment', () => ({ browser: false, dev: false }));
vi.stubGlobal('Image', class {});

const { deleteMessage } = await import('$lib/utils');

type Msg = { id: string; parentId: string | null; childrenIds: string[]; timestamp: number };

function historyOf(...specs: [id: string, parentId: string | null, timestamp: number][]) {
	const messages: Record<string, Msg> = {};
	for (const [id, parentId, timestamp] of specs) {
		messages[id] = { id, parentId, childrenIds: [], timestamp };
		if (parentId !== null) messages[parentId].childrenIds.push(id);
	}
	return { messages, currentId: null as string | null };
}

describe('deleteMessage', () => {
	it('deletes a leaf and unlinks it from its parent', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['a2', 'a1', 3]);
		history.currentId = 'a1';

		const next = deleteMessage(history, 'a2');

		expect(Object.keys(next.messages)).toEqual(['u1', 'a1']);
		expect(next.messages['a1'].childrenIds).toEqual([]);
		expect(next.currentId).toBe('a1');
	});

	it('deletes the response chain of a user message', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2', 'a1', 3], ['a2', 'u2', 4]);
		history.currentId = 'a2';

		const next = deleteMessage(history, 'u2');

		expect(Object.keys(next.messages)).toEqual(['u1', 'a1']);
		expect(next.messages['a1'].childrenIds).toEqual([]);
	});

	it('deletes a branched message with all descendants, sibling branch intact', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2-1', 'a1', 3], ['a2-1', 'u2-1', 4], ['u2-2', 'a1', 5], ['a2-2', 'u2-2', 6], ['u3-2', 'a2-2', 7], ['a3-2', 'u3-2', 8]);
		history.currentId = 'a3-2';

		const next = deleteMessage(history, 'u2-2');

		expect(Object.keys(next.messages).sort()).toEqual(['a1', 'a2-1', 'u1', 'u2-1']);
		expect(next.messages['a1'].childrenIds).toEqual(['u2-1']);
	});

	it('deletes deep subtrees', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2', 'a1', 3], ['a2', 'u2', 4], ['u3', 'a2', 5], ['a3', 'u3', 6], ['u4', 'a3', 7]);
		history.currentId = 'u4';

		const next = deleteMessage(history, 'u2');

		expect(Object.keys(next.messages)).toEqual(['u1', 'a1']);
	});

	it('deleting the root removes the whole tree', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2', 'a1', 3]);
		history.currentId = 'u2';

		const next = deleteMessage(history, 'u1');

		expect(next.messages).toEqual({});
		expect(next.currentId).toBeNull();
	});

	it('preserves sibling order when deleting a middle sibling', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2-1', 'a1', 3], ['u2-2', 'a1', 4], ['u2-3', 'a1', 5]);

		const next = deleteMessage(history, 'u2-2');

		expect(next.messages['a1'].childrenIds).toEqual(['u2-1', 'u2-3']);
	});

	it('falls back to the latest-timestamp message when currentId is deleted', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2-1', 'a1', 3], ['a2-1', 'u2-1', 4], ['u2-2', 'a1', 5], ['a2-2', 'u2-2', 6]);
		history.currentId = 'a2-2';

		const next = deleteMessage(history, 'u2-2');

		expect(next.currentId).toBe('a2-1');
	});

	it('keeps currentId when it survives the deletion', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 2], ['u2-1', 'a1', 3], ['a2-1', 'u2-1', 4], ['u2-2', 'a1', 5]);
		history.currentId = 'a2-1';

		const next = deleteMessage(history, 'u2-2');

		expect(next.currentId).toBe('a2-1');
	});

	it('breaks timestamp ties deterministically by insertion order', () => {
		const history = historyOf(['u1', null, 1], ['a1', 'u1', 5], ['u2', 'a1', 5]);
		history.currentId = 'u2';

		const next = deleteMessage(history, 'u2');

		expect(next.currentId).toBe('a1');
	});
});
