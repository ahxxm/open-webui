import { describe, expect, it, vi } from 'vitest';

import { chatMarked } from './chat-marked';
import {
	EMPTY_LINKS,
	createIncrementalTokenState,
	getRenderSegments,
	updateIncrementalTokenState
} from './incremental';

describe('incremental markdown token state', () => {
	it('freezes the previous mutable block segment when a new block starts', () => {
		let state = createIncrementalTokenState('block');

		state = updateIncrementalTokenState(state, 'alpha');
		const initialMutableId = state.mutableSegment?.id;

		state = updateIncrementalTokenState(state, 'alpha\n\nbeta');
		const segments = getRenderSegments(state);

		expect(segments.map((segment) => segment.id)).toEqual([
			initialMutableId,
			expect.stringMatching(/^segment-\d+$/),
			expect.stringMatching(/^segment-\d+$/)
		]);
		expect(segments[0].tokens[0].type).toBe('paragraph');
		expect(segments[1].tokens[0].type).toBe('space');
		expect(segments[2].tokens[0].type).toBe('paragraph');
		expect((segments[0].tokens[0] as any).text).toBe('alpha');
		expect((segments[2].tokens[0] as any).text).toBe('beta');
	});

	it('seeds inline tail lexing with frozen block links', () => {
		let blockState = createIncrementalTokenState('block');
		blockState = updateIncrementalTokenState(
			blockState,
			['[ref]: https://example.com', '', '[x][ref]'].join('\n')
		);

		expect(blockState.links.ref.href).toBe('https://example.com');

		let inlineState = createIncrementalTokenState('inline', { seedLinks: blockState.links });
		inlineState = updateIncrementalTokenState(inlineState, '[x][ref]', {
			seedLinks: blockState.links
		});

		const inlineToken = getRenderSegments(inlineState)[0].tokens[0] as any;

		expect(inlineToken.type).toBe('link');
		expect(inlineToken.href).toBe('https://example.com');
	});

	it('falls back to a full reset when a definition token appears in the mutable tail', () => {
		let state = createIncrementalTokenState('block');
		state = updateIncrementalTokenState(state, '[x][ref]');

		const previousRenderIds = getRenderSegments(state).map((segment) => segment.id);
		const initialParagraph = state.mutableSegment?.tokens[0] as any;
		expect(initialParagraph.type).toBe('paragraph');
		expect(initialParagraph.tokens?.[0]?.type).toBe('text');

		state = updateIncrementalTokenState(
			state,
			['[x][ref]', '', '[ref]: https://example.com'].join('\n')
		);

		const renderSegments = getRenderSegments(state);
		const reparsedParagraph = renderSegments[0].tokens[0] as any;

		expect(renderSegments[0].id).not.toBe(previousRenderIds[0]);
		expect(reparsedParagraph.type).toBe('paragraph');
		expect(reparsedParagraph.tokens?.[0]?.type).toBe('link');
		expect(state.links.ref.href).toBe('https://example.com');
		expect(state.mutableSegment?.tokens[0].type).toBe('def');
	});

	it('skips block lexing for direct paragraph appends without a newline', () => {
		const lexSpy = vi.spyOn(chatMarked.Lexer.prototype, 'lex');

		try {
			let state = createIncrementalTokenState('block');
			state = updateIncrementalTokenState(state, 'alpha');
			expect(lexSpy).toHaveBeenCalledTimes(1);

			state = updateIncrementalTokenState(state, 'alpha beta');
			expect(lexSpy).toHaveBeenCalledTimes(1);
			expect(state.mutableSegment?.tokens[0].type).toBe('paragraph');
			expect((state.mutableSegment?.tokens[0] as any).text).toBe('alpha beta');
		} finally {
			lexSpy.mockRestore();
		}
	});

	it('keeps frozen inline prefix segments stable while the mutable tail grows', () => {
		let state = createIncrementalTokenState('inline', { seedLinks: EMPTY_LINKS });
		state = updateIncrementalTokenState(state, 'alpha **beta** gamma', {
			seedLinks: EMPTY_LINKS
		});

		const initialSegments = getRenderSegments(state);
		const initialIds = initialSegments.map((segment) => segment.id);
		expect(initialSegments.map((segment) => segment.tokens[0].type)).toEqual([
			'text',
			'strong',
			'text'
		]);

		state = updateIncrementalTokenState(state, 'alpha **beta** gamma delta', {
			seedLinks: EMPTY_LINKS
		});

		const nextSegments = getRenderSegments(state);

		expect(nextSegments.map((segment) => segment.id)).toEqual(initialIds);
		expect((nextSegments[2].tokens[0] as any).text).toBe(' gamma delta');
	});

	it('keeps append-only link closure on the tail-lex path instead of resetting inline state', () => {
		let state = createIncrementalTokenState('inline', { seedLinks: EMPTY_LINKS });
		state = updateIncrementalTokenState(state, 'Start [link](https://example.com/do', {
			seedLinks: EMPTY_LINKS
		});

		expect(
			getRenderSegments(state)
				.flatMap((segment) => segment.tokens)
				.map((token) => token.type)
		).toEqual(['text', 'link']);

		let transition = 'noop';
		state = updateIncrementalTokenState(state, 'Start [link](https://example.com/docs) end', {
			seedLinks: EMPTY_LINKS,
			onTransition(nextTransition) {
				transition = nextTransition;
			}
		});

		const nextSegments = getRenderSegments(state);
		const [prefix, link, suffix] = nextSegments.map((segment) => segment.tokens[0] as any);

		expect(transition).toBe('tail-lex');
		expect(nextSegments.map((segment) => segment.tokens[0].type)).toEqual(['text', 'link', 'text']);
		expect(prefix.text).toBe('Start ');
		expect(link.text).toBe('link');
		expect(link.href).toBe('https://example.com/docs');
		expect(suffix.text).toBe(' end');
	});

	it('keeps a formatted markdown link label mutable until the destination closes', () => {
		let state = createIncrementalTokenState('inline', { seedLinks: EMPTY_LINKS });
		state = updateIncrementalTokenState(state, 'combo [**label**](https://example.com/do', {
			seedLinks: EMPTY_LINKS
		});

		expect(state.frozenSegments).toHaveLength(0);
		expect(
			getRenderSegments(state)
				.flatMap((segment) => segment.tokens)
				.map((token) => token.type)
		).toEqual(['text', 'strong', 'text', 'link']);

		let transition = 'noop';
		state = updateIncrementalTokenState(state, 'combo [**label**](https://example.com/docs)', {
			seedLinks: EMPTY_LINKS,
			onTransition(nextTransition) {
				transition = nextTransition;
			}
		});

		const nextTokens = getRenderSegments(state).flatMap((segment) => segment.tokens) as any[];

		expect(transition).toBe('tail-lex');
		expect(nextTokens.map((token) => token.type)).toEqual(['text', 'link']);
		expect(nextTokens[0].text).toBe('combo ');
		expect(nextTokens[1].text).toBe('**label**');
		expect(nextTokens[1].href).toBe('https://example.com/docs');
		expect(nextTokens[1].tokens?.[0]?.type).toBe('strong');
	});

	it('keeps a formatted markdown image label mutable until the destination closes', () => {
		let state = createIncrementalTokenState('inline', { seedLinks: EMPTY_LINKS });
		state = updateIncrementalTokenState(state, 'combo ![**alt**](https://example.com/image.pn', {
			seedLinks: EMPTY_LINKS
		});

		expect(state.frozenSegments).toHaveLength(0);

		let transition = 'noop';
		state = updateIncrementalTokenState(state, 'combo ![**alt**](https://example.com/image.png)', {
			seedLinks: EMPTY_LINKS,
			onTransition(nextTransition) {
				transition = nextTransition;
			}
		});

		const nextTokens = getRenderSegments(state).flatMap((segment) => segment.tokens) as any[];

		expect(transition).toBe('tail-lex');
		expect(nextTokens.map((token) => token.type)).toEqual(['text', 'image']);
		expect(nextTokens[0].text).toBe('combo ');
		expect(nextTokens[1].text).toBe('**alt**');
		expect(nextTokens[1].href).toBe('https://example.com/image.png');
		expect(nextTokens[1].tokens?.[0]?.type).toBe('strong');
	});

	it('renders streaming inline katex correctly once \\( delimiter closes)', () => {
		const sources = [String.raw`\((\arctan x)\)`, String.raw`\((F(b)-F(-\infty))\)`];

		for (const source of sources) {
			let state = createIncrementalTokenState('inline', { seedLinks: EMPTY_LINKS });

			for (const end of source.split('').map((_, index) => index + 1)) {
				state = updateIncrementalTokenState(state, source.slice(0, end), {
					seedLinks: EMPTY_LINKS
				});
			}

			const tokens = getRenderSegments(state).flatMap((segment) => segment.tokens) as any[];
			const freshTokens = new chatMarked.Lexer(chatMarked.defaults).inlineTokens(source) as any[];

			expect(
				tokens.map((token) => token.type),
				'matches a fresh lex of the complete source'
			).toEqual(freshTokens.map((token) => token.type));
			expect(tokens, 'leaves no escape token behind').not.toContainEqual(
				expect.objectContaining({ type: 'escape' })
			);
			expect(
				tokens.some((token) => token.type === 'inlineKatex' && token.text?.length > 0),
				'keeps the inline katex token with its content'
			).toBe(true);
		}
	});
});
