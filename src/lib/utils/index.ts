import { v7 as uuidv7 } from 'uuid';
import { decode } from 'html-entities';
import { WEBUI_BASE_URL } from '$lib/constants';
import type { ChatHistory } from '$lib/types';

import dayjs from 'dayjs';
import isToday from 'dayjs/plugin/isToday';
import isYesterday from 'dayjs/plugin/isYesterday';
import localizedFormat from 'dayjs/plugin/localizedFormat';

dayjs.extend(isToday);
dayjs.extend(isYesterday);
dayjs.extend(localizedFormat);

// 1x1 transparent PNG — shared drag ghost to suppress default browser preview
export const DRAG_GHOST = new Image();
DRAG_GHOST.src =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

//////////////////////////
// Helper functions
//////////////////////////

export function saveAs(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace tokens outside code blocks only
const replaceOutsideCode = (content: string, replacer: (str: string) => string) => {
	return content
		.split(/(```[\s\S]*?```|`[\s\S]*?`)/)
		.map((segment) => {
			return segment.startsWith('```') || segment.startsWith('`') ? segment : replacer(segment);
		})
		.join('');
};

export const replaceTokens = (content: string, char: string, user: string) => {
	if (!content.includes('{{')) {
		return content;
	}

	return replaceOutsideCode(content, (segment) => {
		return segment
			.replace(/{{char}}/gi, char)
			.replace(/{{user}}/gi, user)
			.replace(
				/{{VIDEO_FILE_ID_([a-f0-9-]+)}}/gi,
				(_: string, fileId: string) =>
					`<video src="${WEBUI_BASE_URL}/api/v1/files/${fileId}/content" controls></video>`
			)
			.replace(
				/{{HTML_FILE_ID_([a-f0-9-]+)}}/gi,
				(_: string, fileId: string) => `<file type="html" id="${fileId}" />`
			);
	});
};

export const sanitizeResponseContent = (content: string) => {
	return content
		.replace(/<\|[a-z]*$/, '')
		.replace(/<\|[a-z]+\|$/, '')
		.replace(/<$/, '')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll(/<\|[a-z]+\|>/g, ' ')
		.trim();
};

export const processResponseContent = (content: string) => {
	if (!/\p{Script=Han}/u.test(content)) {
		return content.trim();
	}

	content = processChineseContent(content);
	return content.trim();
};

function isChineseChar(char: string): boolean {
	return /\p{Script=Han}/u.test(char);
}

// Tackle "Model output issue not following the standard Markdown/LaTeX format" in Chinese.
function processChineseContent(content: string): string {
	// This function is used to process the response content before the response content is rendered.
	const lines = content.split('\n');
	const processedLines = lines.map((line) => {
		if (/[\u4e00-\u9fa5]/.test(line)) {
			// Problems caused by Chinese parentheses
			/* Discription:
			 *   When `*` has Chinese delimiters on the inside, markdown parser ignore bold or italic style.
			 *   - e.g. `**中文名（English）**中文内容` will be parsed directly,
			 *          instead of `<strong>中文名（English）</strong>中文内容`.
			 * Solution:
			 *   Adding a `space` before and after the bold/italic part can solve the problem.
			 *   - e.g. `**中文名（English）**中文内容` -> ` **中文名（English）** 中文内容`
			 * Note:
			 *   Similar problem was found with English parentheses and other full delimiters,
			 *   but they are not handled here because they are less likely to appear in LLM output.
			 *   Change the behavior in future if needed.
			 */
			if (line.includes('*')) {
				// Handle **bold** and *italic*
				// 1. With Chinese parentheses
				if (/（|）/.test(line)) {
					line = processChineseDelimiters(line, '**', '（', '）');
					line = processChineseDelimiters(line, '*', '（', '）');
				}
				// 2. With Chinese quotations
				if (/“|”/.test(line)) {
					line = processChineseDelimiters(line, '**', '“', '”');
					line = processChineseDelimiters(line, '*', '“', '”');
				}
			}
		}
		return line;
	});
	content = processedLines.join('\n');

	return content;
}

// Helper function for `processChineseContent`
function processChineseDelimiters(
	line: string,
	symbol: string,
	leftSymbol: string,
	rightSymbol: string
): string {
	// NOTE: If needed, with a little modification, this function can be applied to more cases.
	const escapedSymbol = escapeRegExp(symbol);
	const regex = new RegExp(
		`(.?)(?<!${escapedSymbol})(${escapedSymbol})([^${escapedSymbol}]+)(${escapedSymbol})(?!${escapedSymbol})(.)`,
		'g'
	);
	return line.replace(regex, (match, l, left, content, right, r) => {
		const result =
			(content.startsWith(leftSymbol) && l && l.length > 0 && isChineseChar(l[l.length - 1])) ||
			(content.endsWith(rightSymbol) && r && r.length > 0 && isChineseChar(r[0]));

		if (result) {
			return `${l} ${left}${content}${right} ${r}`;
		} else {
			return match;
		}
	});
}

export function unescapeHtml(html: string): string {
	return decode(html);
}

export const compressImage = async (imageUrl: string, maxWidth: number, maxHeight: number) => {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			let width = img.width;
			let height = img.height;

			// Maintain aspect ratio while resizing

			if (maxWidth && maxHeight) {
				// Resize with both dimensions defined (preserves aspect ratio)

				if (width <= maxWidth && height <= maxHeight) {
					resolve(imageUrl);
					return;
				}

				if (width / height > maxWidth / maxHeight) {
					height = Math.round((maxWidth * height) / width);
					width = maxWidth;
				} else {
					width = Math.round((maxHeight * width) / height);
					height = maxHeight;
				}
			} else if (maxWidth) {
				// Only maxWidth defined

				if (width <= maxWidth) {
					resolve(imageUrl);
					return;
				}

				height = Math.round((maxWidth * height) / width);
				width = maxWidth;
			} else if (maxHeight) {
				// Only maxHeight defined

				if (height <= maxHeight) {
					resolve(imageUrl);
					return;
				}

				width = Math.round((maxHeight * width) / height);
				height = maxHeight;
			}

			canvas.width = width;
			canvas.height = height;

			const context = canvas.getContext('2d');
			if (!context) return reject(new Error('Canvas 2d context unavailable'));
			context.drawImage(img, 0, 0, width, height);

			// Get compressed image URL
			const mimeType = imageUrl.match(/^data:([^;]+);/)?.[1];
			const compressedUrl = canvas.toDataURL(mimeType);
			resolve(compressedUrl);
		};
		img.onerror = (error) => reject(error);
		img.src = imageUrl;
	});
};
export const formatDate = (inputDate: string | number | Date) => {
	const date = dayjs(inputDate);

	if (date.isToday()) {
		return `Today at {{LOCALIZED_TIME}}`;
	} else if (date.isYesterday()) {
		return `Yesterday at {{LOCALIZED_TIME}}`;
	} else {
		return `{{LOCALIZED_DATE}} at {{LOCALIZED_TIME}}`;
	}
};

export const copyToClipboard = async (
	text: string,
	html: string | null = null,
	formatted = false
): Promise<boolean> => {
	if (formatted) {
		let styledHtml = '';
		if (!html) {
			const [
				{ Marked },
				{ default: markedKatexExtension },
				{ default: markedExtension },
				{ default: hljs }
			] = await Promise.all([
				import('marked'),
				import('$lib/utils/marked/katex-extension'),
				import('$lib/utils/marked/extension'),
				import('$lib/highlight')
			]);

			const clipboardMarked = new Marked();
			clipboardMarked.use(markedKatexExtension({ throwOnError: false }));
			clipboardMarked.use(markedExtension({ throwOnError: false }));
			clipboardMarked.use({
				renderer: {
					code({ text, lang }: { text: string; lang?: string }) {
						const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
						return `<pre><code class="hljs language-${language}">${hljs.highlight(text, { language }).value}</code></pre>`;
					}
				}
			});

			const htmlContent = clipboardMarked.parse(text);

			// Add basic styling to make the content look better when pasted
			styledHtml = `
			<div>
				<style>
					pre {
						background-color: #f6f8fa;
						border-radius: 6px;
						padding: 16px;
						overflow: auto;
					}
					code {
						font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
						font-size: 14px;
					}
					.hljs-keyword { color: #d73a49; }
					.hljs-string { color: #032f62; }
					.hljs-comment { color: #6a737d; }
					.hljs-function { color: #6f42c1; }
					.hljs-number { color: #005cc5; }
					.hljs-operator { color: #d73a49; }
					.hljs-class { color: #6f42c1; }
					.hljs-title { color: #6f42c1; }
					.hljs-params { color: #24292e; }
					.hljs-built_in { color: #005cc5; }
					blockquote {
						border-left: 4px solid #dfe2e5;
						padding-left: 16px;
						color: #6a737d;
						margin-left: 0;
						margin-right: 0;
					}
					table {
						border-collapse: collapse;
						width: 100%;
						margin-bottom: 16px;
					}
					table, th, td {
						border: 1px solid #dfe2e5;
					}
					th, td {
						padding: 8px 12px;
					}
					th {
						background-color: #f6f8fa;
					}
				</style>
				${htmlContent}
			</div>
		`;
		} else {
			// If HTML is provided, use it directly
			styledHtml = html;
		}

		// Create a blob with HTML content
		const blob = new Blob([styledHtml], { type: 'text/html' });

		try {
			// Create a ClipboardItem with HTML content
			const data = new ClipboardItem({
				'text/html': blob,
				'text/plain': new Blob([text], { type: 'text/plain' })
			});

			// Write to clipboard
			await navigator.clipboard.write([data]);
			return true;
		} catch (err) {
			console.error('Error copying formatted content:', err);
			// Fallback to plain text
			return await copyToClipboard(text);
		}
	} else {
		let result = false;
		if (!navigator.clipboard) {
			const textArea = document.createElement('textarea');
			textArea.value = text;

			// Avoid scrolling to bottom
			textArea.style.top = '0';
			textArea.style.left = '0';
			textArea.style.position = 'fixed';

			document.body.appendChild(textArea);
			textArea.focus();
			textArea.select();

			try {
				const successful = document.execCommand('copy');
				const msg = successful ? 'successful' : 'unsuccessful';
				console.log('Fallback: Copying text command was ' + msg);
				result = true;
			} catch (err) {
				console.error('Fallback: Oops, unable to copy', err);
			}

			document.body.removeChild(textArea);
			return result;
		}

		result = await navigator.clipboard
			.writeText(text)
			.then(() => {
				console.log('Async: Copying to clipboard was successful!');
				return true;
			})
			.catch((error) => {
				console.error('Async: Could not copy text: ', error);
				return false;
			});

		return result;
	}
};

const removeDetails = (content: string, types: string[]) => {
	return replaceOutsideCode(content, (segment) => {
		for (const type of types) {
			segment = segment.replace(
				new RegExp(`<details\\s+type="${type}"[^>]*>.*?<\\/details>`, 'gis'),
				''
			);
		}
		return segment;
	});
};

export const removeAllDetails = (content: string) => {
	return replaceOutsideCode(content, (segment) => {
		return segment.replace(/<details[^>]*>.*?<\/details>/gis, '');
	});
};

export const processDetails = (content: string) => {
	return removeDetails(content, ['reasoning', 'web_search']);
};

export const getTimeRange = (timestamp: number) => {
	const now = new Date();
	const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds

	// Calculate the difference in milliseconds
	const diffTime = now.getTime() - date.getTime();
	const diffDays = diffTime / (1000 * 3600 * 24);

	const nowDate = now.getDate();
	const nowMonth = now.getMonth();
	const nowYear = now.getFullYear();

	const dateDate = date.getDate();
	const dateMonth = date.getMonth();
	const dateYear = date.getFullYear();

	if (nowYear === dateYear && nowMonth === dateMonth && nowDate === dateDate) {
		return 'Today';
	} else if (nowYear === dateYear && nowMonth === dateMonth && nowDate - dateDate === 1) {
		return 'Yesterday';
	} else if (diffDays <= 7) {
		return 'Previous 7 days';
	} else if (diffDays <= 30) {
		return 'Previous 30 days';
	} else if (nowYear === dateYear) {
		return date.toLocaleString('default', { month: 'long' });
	} else {
		return date.getFullYear().toString();
	}
};

/**
 * Extract frontmatter as a dictionary from the specified content string.
 * @param content {string} - The content string with potential frontmatter.
 * @returns {Object} - The extracted frontmatter as a dictionary.
 */
export const extractFrontmatter = (content: string) => {
	const frontmatter: Record<string, string> = {};
	let frontmatterStarted = false;
	let frontmatterEnded = false;
	const frontmatterPattern = /^\s*([a-z_]+):\s*(.*)\s*$/i;

	// Split content into lines
	const lines = content.split('\n');

	// Check if the content starts with triple quotes
	if (lines[0].trim() !== '"""') {
		return {};
	}

	frontmatterStarted = true;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];

		if (line.includes('"""')) {
			if (frontmatterStarted) {
				frontmatterEnded = true;
				break;
			}
		}

		if (frontmatterStarted && !frontmatterEnded) {
			const match = frontmatterPattern.exec(line);
			if (match) {
				const [, key, value] = match;
				frontmatter[key.trim()] = value.trim();
			}
		}
	}

	return frontmatter;
};

// Function to determine the best matching language
export const bestMatchingLanguage = (
	supportedLanguages: { code: string }[],
	preferredLanguages: readonly string[],
	defaultLocale: string
) => {
	const languages = supportedLanguages.map((lang) => lang.code);

	const match = preferredLanguages
		.map((prefLang: string) => languages.find((lang: string) => lang.startsWith(prefLang)))
		.find(Boolean);

	return match || defaultLocale;
};

export const deleteMessage = (history: ChatHistory, messageId: string): ChatHistory => {
	const messages = history.messages;
	if (!messages[messageId]) {
		throw new Error(`Message ${messageId} not found`);
	}

	const parentMessageId = messages[messageId].parentId;
	const childMessageIds = messages[messageId].childrenIds;

	const grandchildIds = childMessageIds.flatMap((childId) => messages[childId]?.childrenIds ?? []);

	const nextMessages = { ...messages };
	if (parentMessageId !== null && nextMessages[parentMessageId]) {
		nextMessages[parentMessageId] = {
			...nextMessages[parentMessageId],
			childrenIds: [
				...nextMessages[parentMessageId].childrenIds.filter((id) => id !== messageId),
				...grandchildIds
			]
		};
	}

	grandchildIds.forEach((grandchildId) => {
		if (nextMessages[grandchildId]) {
			nextMessages[grandchildId] = { ...nextMessages[grandchildId], parentId: parentMessageId };
		}
	});

	for (const id of [messageId, ...childMessageIds]) {
		delete nextMessages[id];
	}

	return { messages: nextMessages, currentId: history.currentId };
};

export const createMessagesList = (
	history: { messages: Record<string, any> },
	messageId: string | null
): any[] => {
	if (messageId === null) return [];

	const messages: any[] = [];
	const visitedMessageIds = new Set<string>();
	let currentMessageId: string | null = messageId;

	while (currentMessageId !== null) {
		if (visitedMessageIds.has(currentMessageId)) {
			console.warn('Circular dependency detected in message history', currentMessageId);
			break;
		}

		visitedMessageIds.add(currentMessageId);

		const currentMessage: Record<string, any> | undefined = history.messages[currentMessageId];
		if (currentMessage === undefined) {
			break;
		}

		messages.push(currentMessage);
		currentMessageId = currentMessage.parentId ?? null;
	}

	return messages.reverse();
};

export const formatFileSize = (size: number | null | undefined) => {
	if (size == null) return 'Unknown size';
	if (typeof size !== 'number' || size < 0) return 'Invalid size';
	if (size === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}
	return `${size.toFixed(1)} ${units[unitIndex]}`;
};

export const getLineCount = (text: string) => {
	console.log(typeof text);
	return text ? text.split('\n').length : 0;
};

export const extractContentFromFile = async (file: File) => {
	// Known text file extensions for extra fallback
	const textExtensions = [
		'.txt',
		'.md',
		'.csv',
		'.json',
		'.js',
		'.ts',
		'.css',
		'.html',
		'.xml',
		'.yaml',
		'.yml',
		'.rtf'
	];

	function getExtension(filename: string) {
		const dot = filename.lastIndexOf('.');
		return dot === -1 ? '' : filename.substr(dot).toLowerCase();
	}

	// Reads file as text using FileReader
	function readAsText(file: File) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = reject;
			reader.readAsText(file);
		});
	}

	const type = file.type || '';
	const ext = getExtension(file.name);

	// Text check (plain or common text-based)
	if (type.startsWith('text/') || textExtensions.includes(ext)) {
		return await readAsText(file);
	}

	// Fallback: try to read as text, if decodable
	try {
		return await readAsText(file);
	} catch (err) {
		throw new Error('Unsupported or non-text file type: ' + (file.name || type));
	}
};

export const decodeString = (str: string) => {
	try {
		return decodeURIComponent(str);
	} catch (e) {
		return str;
	}
};
