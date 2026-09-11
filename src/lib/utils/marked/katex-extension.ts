import type { MarkedExtension, Token, TokenizerAndRendererExtension, Tokens } from 'marked';

export type KatexToken = Token & {
	type: 'inlineKatex' | 'blockKatex';
	text: string;
	displayMode: boolean;
};

interface MathDelimiter {
	left: string;
	right: string;
	display: boolean;
}

const DELIMITER_LIST: MathDelimiter[] = [
	{ left: '$$', right: '$$', display: true },
	{ left: '$', right: '$', display: false },
	{ left: '\\pu{', right: '}', display: false },
	{ left: '\\ce{', right: '}', display: false },
	{ left: '\\(', right: '\\)', display: false },
	{ left: '\\[', right: '\\]', display: true },
	{ left: '\\begin{equation}', right: '\\end{equation}', display: true }
];

// Defines characters that are allowed to immediately precede or follow a math delimiter.
const ALLOWED_SURROUNDING_CHARS =
	'\\s。，、､;；„“‘’“”（）「」『』［］《》【】‹›«»…⋯:：？！～⇒?!-/:-@\\[-`{-~\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
// Modified to fit more formats in different languages. Originally: '\\s?。，、；!-\\/:-@\\[-`{-~\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';

// Pre-compile the surrounding character regex once at module load time.
// This regex uses Unicode property escapes (\p{Script=Han}, etc.) which are
// extremely expensive to compile - doing so on every call caused ~87% of
// markdown rendering time to be spent in KaTeX regex compilation.
const ALLOWED_SURROUNDING_CHARS_REGEX = new RegExp(`[${ALLOWED_SURROUNDING_CHARS}]`, 'u');

const inlinePatterns: string[] = [];
const blockPatterns: string[] = [];

function escapeRegex(string: string): string {
	return string.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function generateRegexRules(delimiters: MathDelimiter[]): {
	inlineRule: RegExp;
	blockRule: RegExp;
} {
	delimiters.forEach((delimiter) => {
		const { left, right, display } = delimiter;
		// Ensure regex-safe delimiters
		const escapedLeft = escapeRegex(left);
		const escapedRight = escapeRegex(right);

		if (!display) {
			// For inline delimiters, we match everything
			inlinePatterns.push(`${escapedLeft}((?:\\\\[^]|[^\\\\])+?)${escapedRight}`);
		} else {
			// Block delimiters doubles as inline delimiters when not followed by a newline
			inlinePatterns.push(`${escapedLeft}(?!\\n)((?:\\\\[^]|[^\\\\])+?)(?!\\n)${escapedRight}`);
			blockPatterns.push(`${escapedLeft}\\n((?:\\\\[^]|[^\\\\])+?)\\n${escapedRight}`);
		}
	});

	// Math formulas can end in special characters
	const inlineRule = new RegExp(
		`^(${inlinePatterns.join('|')})(?=[${ALLOWED_SURROUNDING_CHARS}]|$)`,
		'u'
	);
	const blockRule = new RegExp(
		`^(${blockPatterns.join('|')})(?=[${ALLOWED_SURROUNDING_CHARS}]|$)`,
		'u'
	);

	return { inlineRule, blockRule };
}

const { inlineRule, blockRule } = generateRegexRules(DELIMITER_LIST);

export default function (): MarkedExtension {
	return {
		extensions: [inlineKatex(), blockKatex()]
	};
}

function katexStart(src: string, displayMode: boolean): number | undefined {
	for (let i = 0; i < src.length; i++) {
		const ch = src.charCodeAt(i);

		if (ch === 36 /* $ */) {
			// Display mode requires $$, skip single $ for display
			if (displayMode && src.charAt(i + 1) !== '$') {
				continue;
			}
			if (i === 0 || ALLOWED_SURROUNDING_CHARS_REGEX.test(src.charAt(i - 1))) {
				return i;
			}
		} else if (ch === 92 /* \ */) {
			const next = src.charAt(i + 1);
			// Only consider \ if followed by a valid math delimiter start
			if (displayMode) {
				// Display: \[ or \begin{equation}
				if (next !== '[' && next !== 'b') continue;
			} else {
				// Inline: \( or \ce{ or \pu{
				if (next !== '(' && next !== 'c' && next !== 'p') continue;
			}
			if (i === 0 || ALLOWED_SURROUNDING_CHARS_REGEX.test(src.charAt(i - 1))) {
				return i;
			}
		}
	}
}

function katexTokenizer(
	src: string,
	tokens: Token[] | Tokens.List,
	displayMode: boolean
): KatexToken | undefined {
	const ruleReg = displayMode ? blockRule : inlineRule;
	const type = displayMode ? 'blockKatex' : 'inlineKatex';

	const match = src.match(ruleReg);

	if (match) {
		const text = match
			.slice(2)
			.filter((item) => item)
			.find((item) => item.trim());

		return {
			type,
			raw: match[0],
			text: text ?? '',
			displayMode
		};
	}
}

function inlineKatex(): TokenizerAndRendererExtension {
	return {
		name: 'inlineKatex',
		level: 'inline',
		start(src: string) {
			return katexStart(src, false);
		},
		tokenizer(src: string, tokens) {
			return katexTokenizer(src, tokens, false);
		},
		renderer(token) {
			return `${(token as KatexToken)?.text ?? ''}`;
		}
	};
}

function blockKatex(): TokenizerAndRendererExtension {
	return {
		name: 'blockKatex',
		level: 'block',
		start(src: string) {
			return katexStart(src, true);
		},
		tokenizer(src: string, tokens) {
			return katexTokenizer(src, tokens, true);
		},
		renderer(token) {
			return `${(token as KatexToken)?.text ?? ''}`;
		}
	};
}
