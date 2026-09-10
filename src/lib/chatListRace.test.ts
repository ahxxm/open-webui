// @vitest-environment jsdom
/**
 * Shift-deleting two chats in quick succession should leave the remaining
 * chats visible in the sidebar.
 * e.g. Shift-delete 2 of 70 (2 pages) should leave 68 visible.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writable, get } from 'svelte/store';
import { signIn, installFetchProxy, flushFetches } from '$lib/test/backend';

// ── SvelteKit stubs (virtual modules not available in vitest) ────────────────

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), afterNavigate: vi.fn() }));
vi.mock('$app/stores', () => ({
	page: {
		subscribe: vi.fn((cb: any) => {
			cb({ url: new URL('http://localhost'), params: {} });
			return () => {};
		})
	},
	navigating: {
		subscribe: vi.fn((cb: any) => {
			cb(null);
			return () => {};
		})
	}
}));

// Sidebar imports these but they're not relevant to the chat list race
vi.mock('$lib/apis/folders', () => ({
	createNewFolder: vi.fn(),
	getFolders: vi.fn().mockResolvedValue([])
}));
vi.mock('$lib/apis/tasks', () => ({
	checkActiveChats: vi.fn().mockResolvedValue({ active_chat_ids: [] })
}));

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { delay, waitFor } from '$lib/test/async';
import {
	chats,
	pinnedChats,
	currentChatPage,
	scrollPaginationEnabled,
	showSidebar,
	user
} from '$lib/stores';

// Artificial per-request delay so initChatList's multi-fetch chain takes
// long enough for IntersectionObserver ticks (100ms) to interleave
const NET = 50;
const CLICK_GAP = NET * 2;

// ── Store setup ──────────────────────────────────────────────────────────────
// Minimal store state so the component renders: user logged in, sidebar open.
// Chat list is NOT seeded — Sidebar's initChatList fetches from the real backend.

function seedStores() {
	user.set({
		id: '1',
		name: 'Admin',
		email: 'admin@localhost',
		role: 'admin'
	} as any);
	showSidebar.set(true);
	pinnedChats.set([]);
	currentChatPage.set(1);
	scrollPaginationEnabled.set(true);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Sidebar: shift-delete race', () => {
	beforeEach(async () => {
		// jsdom lacks IntersectionObserver. Loader uses observe/unobserve/rAF
		// reobserve loop. This mock fires the callback asynchronously on each
		// observe(), matching real behavior where the element is always visible.
		// Browsers have the real thing — leave it alone there.
		if (typeof IntersectionObserver === 'undefined') {
			vi.stubGlobal(
				'IntersectionObserver',
				class {
					cb: any;
					timerId: any;
					active = true;
					constructor(cb: any) {
						this.cb = cb;
					}
					observe(el: Element) {
						if (!this.active) return;
						this.timerId = setTimeout(() => {
							if (this.active) this.cb([{ isIntersecting: true, target: el }]);
						}, 0);
					}
					unobserve() {
						clearTimeout(this.timerId);
					}
					disconnect() {
						this.active = false;
						clearTimeout(this.timerId);
					}
				}
			);
		}
		if (typeof requestAnimationFrame === 'undefined') {
			vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
				const id = setTimeout(() => fn(0), 0);
				return id;
			});
		}

		// jsdom lacks Web Animations API
		Element.prototype.animate ??= function () {
			return { onfinish: null, cancel() {}, finished: Promise.resolve() } as any;
		};

		// Sidebar's onMount reads this to decide whether to show + call initChatList
		localStorage.setItem('sidebar', 'true');

		const token = await signIn();
		localStorage.setItem('token', token);
		installFetchProxy(token, NET);

		// Clean slate: delete all chats, then seed 70 (page size is 60, so 2 pages)
		await fetch('/api/v1/chats/', { method: 'DELETE' });
		for (let i = 0; i < 70; i++) {
			await fetch('/api/v1/chats/new', {
				method: 'POST',
				body: JSON.stringify({ chat: { title: `Chat ${i}` } })
			});
		}

		seedStores();
	});

	afterEach(async () => {
		await flushFetches();
		cleanup();
		vi.restoreAllMocks();
	});

	it('shift-delete 2 of 70 → should still show 68 chats across both pages', async () => {
		const { default: Sidebar } = await import('$lib/components/layout/Sidebar.svelte');
		const { container } = render(Sidebar, {
			context: new Map([['i18n', writable({ t: (k: string) => k })]])
		});

		// Wait for initChatList + loadMoreChats to load all 70 chats
		await waitFor(() => container.querySelectorAll('a[href^="/c/"]').length === 70);

		const chatLinks = container.querySelectorAll('a[href^="/c/"]');
		expect(chatLinks.length, `expected 70 chats after mount, got ${chatLinks.length}`).toBe(70);

		// Record all chat IDs and which two we'll delete
		const chatIdOf = (link: Element) => link.getAttribute('href')!.replace('/c/', '');
		const allIdsBefore = new Set([...chatLinks].map(chatIdOf));
		const [first, second] = chatLinks;
		const deletedIds = new Set([chatIdOf(first), chatIdOf(second)]);
		const expectedSurvivors = [...allIdsBefore].filter((id) => !deletedIds.has(id));

		// Sidebar syncs shiftKey from window keydown/mousemove events;
		// ChatItem shows the trash button only when shiftKey && mouseOver
		await fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
		await fireEvent.mouseMove(window, { shiftKey: true });

		const clickTrashOn = async (chatLink: Element) => {
			await fireEvent.mouseEnter(chatLink);
			const trash = chatLink.closest('li, div')?.querySelector('[aria-label="Delete chat"]');
			expect(trash, 'shift+hover should reveal trash button').toBeTruthy();
			await fireEvent.click(trash!);
		};

		await clickTrashOn(first);
		await delay(CLICK_GAP);
		await clickTrashOn(second);

		// Wait for both delete + refetch cycles to settle
		await waitFor(() => {
			const c = get(chats) as any[] | null;
			return c !== null && c.length <= 68;
		});

		const result = get(chats) as any[] | null;
		expect(result).not.toBeNull();
		expect(result!.length, `expected 68 chats, got ${result!.length}`).toBe(68);

		const survivingIds = new Set(result!.map((c: any) => c.id));
		for (const id of expectedSurvivors) {
			expect(survivingIds.has(id), `chat ${id} should still be in the store`).toBe(true);
		}
	}, 30000);
});
