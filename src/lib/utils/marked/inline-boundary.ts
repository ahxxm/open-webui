import type { Token } from 'marked';

/**
 * Conservative inline-boundary detector for incremental markdown streaming.
 *
 * This code intentionally over-resets. When a boundary might split an unfinished
 * inline construct, the caller falls back to reparsing the mutable suffix rather
 * than risk stale rendered output. The rules here are coupled to the token
 * shapes emitted by marked today, so the focused tests in this directory are the
 * guardrail against silent regressions.
 */

type OpenBracketedInlineConstruct =
	| { state: 'label'; bracketDepth: number }
	| { state: 'after-label' }
	| { state: 'destination'; parenthesisDepth: number }
	| { state: 'reference'; bracketDepth: number };

export const getInlineMutableTokenStartIndex = (tokens: Token[]): number => {
	let lastSafeBoundary = 0;
	let openBracketedInlineConstructs: OpenBracketedInlineConstruct[] = [];

	for (let index = 0; index < tokens.length - 1; index += 1) {
		const token = tokens[index];
		const tokenRaw =
			token.type === 'link' || token.type === 'image' || token.type === 'citation'
				? ''
				: getTokenRaw(token);

		openBracketedInlineConstructs = updateOpenBracketedInlineConstructs(
			openBracketedInlineConstructs,
			tokenRaw
		);

		if (
			!isUnsafeInlineBoundary(token, tokens[index + 1], openBracketedInlineConstructs.length > 0)
		) {
			lastSafeBoundary = index + 1;
		}
	}

	return lastSafeBoundary;
};

export const isUnsafeInlineBoundary = (
	previousToken: Token,
	nextToken: Token,
	hasOpenBracketedInlineConstructInPrefix = false
): boolean => {
	if (hasOpenBracketedInlineConstructInPrefix) {
		return true;
	}

	if (previousToken.type === 'br' || nextToken.type === 'br') {
		return true;
	}

	// An escape token (e.g. \\( ) can be the leading half of an inline math
	// delimiter; a later update may still close it, so never freeze across it.
	if (previousToken.type === 'escape' || nextToken.type === 'escape') {
		return true;
	}

	if (previousToken.type === 'text') {
		const previousRaw = getTokenRaw(previousToken);

		if (nextToken.type !== 'text' && textTokenContainsPotentialInlineOpener(previousRaw)) {
			return true;
		}

		if (nextToken.type === 'link' && /(?:!?\[[^\]\r\n]*\]\(|<)$/.test(previousRaw)) {
			return true;
		}

		if (
			(nextToken.type === 'em' || nextToken.type === 'strong' || nextToken.type === 'del') &&
			textTokenContainsPotentialInlineOpener(previousRaw)
		) {
			return true;
		}
	}

	if (previousToken.type === 'link' && nextToken.type === 'text') {
		const previousRaw = getTokenRaw(previousToken);
		const previousText = 'text' in previousToken ? (previousToken.text ?? '') : '';
		const previousHref = 'href' in previousToken ? (previousToken.href ?? '') : '';

		if (
			previousRaw === previousText &&
			previousRaw === previousHref &&
			/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]/.test(getTokenRaw(nextToken))
		) {
			return true;
		}
	}

	if (
		(previousToken.type === 'em' ||
			previousToken.type === 'strong' ||
			previousToken.type === 'del') &&
		nextToken.type === 'text'
	) {
		const triggerPrefix = getInlineBoundaryTriggerPrefix(previousToken.raw ?? '');
		if (triggerPrefix && getTokenRaw(nextToken).startsWith(triggerPrefix)) {
			return true;
		}
	}

	return false;
};

export const getTokenRaw = (token: Token): string => token.raw ?? '';

const textTokenContainsPotentialInlineOpener = (raw: string): boolean =>
	/[*_~`$<\\\n]/.test(raw) ||
	/!\[[^\]\r\n]*$/.test(raw) ||
	/\[[^\]\r\n]*$/.test(raw) ||
	/\]\([^\)\r\n]*$/.test(raw);

const updateOpenBracketedInlineConstructs = (
	openConstructs: OpenBracketedInlineConstruct[],
	raw: string
): OpenBracketedInlineConstruct[] => {
	if (!raw) {
		return openConstructs;
	}

	let index = 0;

	while (index < raw.length) {
		if (raw[index] === '\\') {
			index += 2;
			continue;
		}

		const activeConstruct = openConstructs.at(-1);

		if (activeConstruct?.state === 'destination') {
			if (raw[index] === '(') {
				activeConstruct.parenthesisDepth += 1;
			} else if (raw[index] === ')') {
				activeConstruct.parenthesisDepth -= 1;
				if (activeConstruct.parenthesisDepth === 0) {
					openConstructs.pop();
				}
			}

			index += 1;
			continue;
		}

		if (activeConstruct?.state === 'reference') {
			if (raw[index] === '[') {
				activeConstruct.bracketDepth += 1;
			} else if (raw[index] === ']') {
				activeConstruct.bracketDepth -= 1;
				if (activeConstruct.bracketDepth === 0) {
					openConstructs.pop();
				}
			}

			index += 1;
			continue;
		}

		if (activeConstruct?.state === 'after-label') {
			if (raw[index] === '(') {
				openConstructs[openConstructs.length - 1] = {
					state: 'destination',
					parenthesisDepth: 1
				};
				index += 1;
				continue;
			}

			if (raw[index] === '[') {
				openConstructs[openConstructs.length - 1] = {
					state: 'reference',
					bracketDepth: 1
				};
				index += 1;
				continue;
			}

			openConstructs.pop();
			continue;
		}

		if (activeConstruct?.state === 'label') {
			if (raw[index] === '[') {
				activeConstruct.bracketDepth += 1;
			} else if (raw[index] === ']') {
				activeConstruct.bracketDepth -= 1;
				if (activeConstruct.bracketDepth === 0) {
					openConstructs[openConstructs.length - 1] = {
						state: 'after-label'
					};
				}
			}

			index += 1;
			continue;
		}

		if (raw[index] === '!' && raw[index + 1] === '[') {
			openConstructs.push({ state: 'label', bracketDepth: 1 });
			index += 2;
			continue;
		}

		if (raw[index] === '[') {
			openConstructs.push({ state: 'label', bracketDepth: 1 });
			index += 1;
			continue;
		}

		index += 1;
	}

	return openConstructs;
};

/**
 * Return the smallest prefix on the next token that proves the previous token's
 * closing delimiter may actually belong to a longer inline run across the
 * boundary. This is intentionally conservative: for **strong** a leading `*`
 * on the next token is already enough to make the split unsafe.
 */
const getInlineBoundaryTriggerPrefix = (raw: string): string => {
	for (const delimiter of ['**', '__', '~~', '*', '_'] as const) {
		if (raw.startsWith(delimiter) && raw.endsWith(delimiter)) {
			return delimiter[0];
		}
	}

	return '';
};
