import { describe, expect, it, vi } from 'vitest';
import type { Token, Tokens } from 'marked';

import { chatMarked } from './chat-marked';
import type { KatexToken } from './katex-extension';
import {
	EMPTY_LINKS,
	createIncrementalTokenState,
	getRenderSegments,
	updateIncrementalTokenState
} from './incremental';

type TokenTypeMap = {
	text: Tokens.Text;
	link: Tokens.Link;
	image: Tokens.Image;
	paragraph: Tokens.Paragraph;
	inlineKatex: KatexToken;
};

// Asserts the token type at runtime, then narrows it so property access type-checks.
const expectToken = <K extends keyof TokenTypeMap>(
	token: Token | undefined,
	type: K
): TokenTypeMap[K] => {
	expect(token?.type).toBe(type);
	return token as TokenTypeMap[K];
};

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
		expect(segments[1].tokens[0].type).toBe('space');
		expect(expectToken(segments[0].tokens[0], 'paragraph').text).toBe('alpha');
		expect(expectToken(segments[2].tokens[0], 'paragraph').text).toBe('beta');
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

		expect(expectToken(getRenderSegments(inlineState)[0].tokens[0], 'link').href).toBe(
			'https://example.com'
		);
	});

	it('falls back to a full reset when a definition token appears in the mutable tail', () => {
		let state = createIncrementalTokenState('block');
		state = updateIncrementalTokenState(state, '[x][ref]');

		const previousRenderIds = getRenderSegments(state).map((segment) => segment.id);
		const initialParagraph = expectToken(state.mutableSegment?.tokens[0], 'paragraph');
		expect(initialParagraph.tokens?.[0]?.type).toBe('text');

		state = updateIncrementalTokenState(
			state,
			['[x][ref]', '', '[ref]: https://example.com'].join('\n')
		);

		const renderSegments = getRenderSegments(state);
		const reparsedParagraph = expectToken(renderSegments[0].tokens[0], 'paragraph');

		expect(renderSegments[0].id).not.toBe(previousRenderIds[0]);
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
			expect(expectToken(state.mutableSegment?.tokens[0], 'paragraph').text).toBe('alpha beta');
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
		expect(expectToken(nextSegments[2].tokens[0], 'text').text).toBe(' gamma delta');
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
		const [prefixToken, linkToken, suffixToken] = nextSegments.map((segment) => segment.tokens[0]);
		const prefix = expectToken(prefixToken, 'text');
		const link = expectToken(linkToken, 'link');
		const suffix = expectToken(suffixToken, 'text');

		expect(transition).toBe('tail-lex');
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

		const nextTokens = getRenderSegments(state).flatMap((segment) => segment.tokens);

		expect(transition).toBe('tail-lex');
		const prefix = expectToken(nextTokens[0], 'text');
		const link = expectToken(nextTokens[1], 'link');
		expect(prefix.text).toBe('combo ');
		expect(link.text).toBe('**label**');
		expect(link.href).toBe('https://example.com/docs');
		expect(link.tokens?.[0]?.type).toBe('strong');
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

		const nextTokens = getRenderSegments(state).flatMap((segment) => segment.tokens);

		expect(transition).toBe('tail-lex');
		const prefix = expectToken(nextTokens[0], 'text');
		const image = expectToken(nextTokens[1], 'image');
		expect(prefix.text).toBe('combo ');
		expect(image.text).toBe('**alt**');
		expect(image.href).toBe('https://example.com/image.png');
		expect(image.tokens?.[0]?.type).toBe('strong');
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

			const tokens = getRenderSegments(state).flatMap((segment) => segment.tokens);
			const freshTokens = new chatMarked.Lexer(chatMarked.defaults).inlineTokens(source);

			expect(
				tokens.map((token) => token.type),
				'matches a fresh lex of the complete source'
			).toEqual(freshTokens.map((token) => token.type));
			expect(tokens, 'leaves no escape token behind').not.toContainEqual(
				expect.objectContaining({ type: 'escape' })
			);
			const katexToken = tokens.find((token) => token.type === 'inlineKatex');
			expect(
				expectToken(katexToken, 'inlineKatex').text.length,
				'keeps the inline katex token with its content'
			).toBeGreaterThan(0);
		}
	});
});
