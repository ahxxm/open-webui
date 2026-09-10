// Mirrors backend ChatTitleIdResponse + frontend time_range augmentation
export type ChatListItem = {
	id: string;
	title: string;
	updated_at: number;
	created_at: number;
	time_range?: string;
};

// Structural fields every message has; streaming adds arbitrary fields on top.
export type ChatMessage = {
	id: string;
	parentId: string | null;
	childrenIds: string[];
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	[key: string]: any;
};

// Chat blob internals (stored in chat.chat JSON column)
export type ChatHistory = {
	messages: Record<string, ChatMessage>;
	currentId: string | null;
};

// Mirrors backend FolderNameIdResponse (what GET /folders/ returns)
export type FolderItem = {
	id: string;
	name: string;
	meta?: Record<string, any> | null;
	is_expanded: boolean;
	created_at: number;
	updated_at: number;
	// Frontend-only: enriched by Sidebar from full folder data
	data?: Record<string, any> | null;
	items?: { chat_ids?: string[]; file_ids?: string[] } | null;
};
