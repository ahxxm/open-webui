import { Marked } from 'marked';
import markedKatexExtension from './katex-extension';
import markedExtension from './extension';
import citationExtension from './citation-extension';
import footnoteExtension from './footnote-extension';
import { disableSingleTilde } from './strikethrough-extension';

const chatMarked = new Marked();

const options = { throwOnError: false };

chatMarked.use(markedKatexExtension());
chatMarked.use(markedExtension(options));
chatMarked.use(citationExtension());
chatMarked.use(footnoteExtension());
chatMarked.use(disableSingleTilde);
chatMarked.use({ breaks: true });

export { chatMarked };
