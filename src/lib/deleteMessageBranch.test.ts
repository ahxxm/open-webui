// @vitest-environment jsdom
/**
 * Deleting a message should recursively remove descendants.
 *
 * Background: deletion is implemented as a history override in frontend.
 *
 * Tree in this test (U/A = user/assistant, -2 = branch created by editing
 * and resubmitting U2-1 as a sibling under A1):
 *
 *   U1 → A1 → U2-1 → A2-1
 *        └── U2-2 → A2-2 → U3-2 → A3-2   (currentId = A3-2)
 *
 * Deleting U2-2 should remove the whole 2nd line.
 */
import { vi, describe, it, expect, afterEach } from 'vitest';
import { writable } from 'svelte/store';
import { render, fireEvent, cleanup, within } from '@testing-library/svelte';
import { delay, waitFor } from '$lib/test/async';
import type { ChatHistory } from '$lib/types';

// jsdom lacks layout info, so focus-trap throws on dialog open
vi.mock('focus-trap', () => ({
	createFocusTrap: () => ({ activate() {}, deactivate() {} })
}));

function seedHistory(): ChatHistory {
	const messages: ChatHistory['messages'] = {};
	const add = (id: string, parentId: string | null, role: 'user' | 'assistant', content: string) => {
		messages[id] = { id, parentId, childrenIds: [], role, content, timestamp: 0 };
		if (parentId !== null) messages[parentId].childrenIds.push(id);
	};

	add('u1', null, 'user', 'hello');
	add('a1', 'u1', 'assistant', 'hi there');
	add('u2-1', 'a1', 'user', 'first attempt');
	add('a2-1', 'u2-1', 'assistant', 'first answer');
	add('u2-2', 'a1', 'user', 'edited resubmission');
	add('a2-2', 'u2-2', 'assistant', 'answer to edited');
	add('u3-2', 'a2-2', 'user', 'follow-up');
	add('a3-2', 'u3-2', 'assistant', 'answer to follow-up');

	return { messages, currentId: 'a3-2' };
}

describe('Messages: deleting a branched user message deletes its whole subtree', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('deleting U2-2 removes A2-2, U3-2, A3-2 and leaves the U2-1 branch intact', async () => {
		// ConfirmDialog animates via WAAPI, which jsdom lacks
		Element.prototype.animate ??= function () {
			return { onfinish: null, cancel() {}, finished: Promise.resolve() } as any;
		};

		const history = seedHistory();
		const { default: Messages } = await import('$lib/components/chat/Messages.svelte');
		render(Messages, {
			context: new Map([['i18n', writable({ t: (key: string) => key })]]),
			props: {
				chatId: 'test-chat',
				history,
				streamingMessages: {},
				selectedModels: ['test-model']
			}
		});

		await waitFor(() => document.getElementById('message-u2-2') !== null);
		expect(document.getElementById('message-u2-1')).toBeNull();

		const row = within(document.getElementById('message-u2-2')!);
		fireEvent.click(row.getByRole('button', { name: 'Delete' }));

		await waitFor(() => document.body.textContent!.includes('Delete message?'));
		fireEvent.click(within(document.body).getByRole('button', { name: 'Confirm' }));
		await delay(50);

		for (const id of ['u2-2', 'a2-2', 'u3-2', 'a3-2']) {
			expect(history.messages[id], `${id} should be deleted`).toBeUndefined();
		}
		expect(history.messages['u2-1']).toBeDefined();
		expect(history.messages['a2-1']).toBeDefined();
		expect(history.messages['a1'].childrenIds).toEqual(['u2-1']);

		expect(
			history.currentId && history.messages[history.currentId],
			'currentId must not dangle after delete'
		).toBeDefined();
	}, 30000);
});
