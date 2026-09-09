<script lang="ts">
	import { v7 as uuidv7 } from 'uuid';
	import { settings, user as _user, temporaryChatEnabled, refreshChatList } from '$lib/stores';
	import { tick, getContext, untrack } from 'svelte';

	import { toast } from 'svelte-sonner';
	import { updateChatById } from '$lib/apis/chats';
	import { createMessagesList, deleteMessage as deleteMessageInHistory } from '$lib/utils';

	import Message from './Messages/Message.svelte';
	import Loader from '../common/Loader.svelte';
	import Spinner from '../common/Spinner.svelte';

	import ChatPlaceholder from './ChatPlaceholder.svelte';

	const i18n = getContext('i18n');

	let {
		className = 'h-full flex pt-8',
		chatId = '',
		user = $_user,
		history = $bindable({ messages: {}, currentId: null }),
		selectedModels = [],
		streamingMessages,
		setInputText = () => {},
		sendMessage,
		continueResponse,
		regenerateResponse,
		showMessage = () => {},
		submitMessage = () => {},
		addMessages = () => {},
		readOnly = false,
		topPadding = false,
		bottomPadding = false,
		autoScroll = $bindable(undefined),
		onSelect = (e) => {},
		messagesCount = $bindable(20),
		scrollToBottom = () => {}
	} = $props();

	let messageIds: string[] = $derived.by(() => {
		if (!history.currentId) return [];

		let ids: string[] = [];
		let message = history.messages[history.currentId];
		const visitedMessageIds = new Set();

		while (message && (messagesCount !== null ? ids.length <= messagesCount : true)) {
			if (visitedMessageIds.has(message.id)) {
				console.warn('Circular dependency detected in message history', message.id);
				break;
			}
			visitedMessageIds.add(message.id);
			ids.push(message.id);
			message = message.parentId !== null ? history.messages[message.parentId] : null;
		}

		return ids.reverse();
	});
	let firstMessage = $derived(messageIds.length > 0 ? history.messages[messageIds[0]] : null);
	let messagesLoading = $state(false);

	const loadMoreMessages = async () => {
		const element = document.getElementById('messages-container');
		element.scrollTop = element.scrollTop + 100;

		messagesLoading = true;
		messagesCount += 20;

		await tick();

		messagesLoading = false;
	};

	$effect(() => {
		if (autoScroll && bottomPadding) {
			tick().then(() => untrack(() => scrollToBottom()));
		}
	});

	const updateChat = async () => {
		if (!$temporaryChatEnabled) {
			await tick();
			await updateChatById(localStorage.token, chatId, {
				history: history,
				messages: createMessagesList(history, history.currentId)
			});

			await refreshChatList(localStorage.token);
		}
	};

	const showPreviousMessage = async (message) => {
		if (message.parentId !== null) {
			let messageId =
				history.messages[message.parentId].childrenIds[
					Math.max(history.messages[message.parentId].childrenIds.indexOf(message.id) - 1, 0)
				];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		} else {
			let childrenIds = Object.values(history.messages)
				.filter((message) => message.parentId === null)
				.map((message) => message.id);
			let messageId = childrenIds[Math.max(childrenIds.indexOf(message.id) - 1, 0)];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		}
	};

	const showNextMessage = async (message) => {
		if (message.parentId !== null) {
			let messageId =
				history.messages[message.parentId].childrenIds[
					Math.min(
						history.messages[message.parentId].childrenIds.indexOf(message.id) + 1,
						history.messages[message.parentId].childrenIds.length - 1
					)
				];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		} else {
			let childrenIds = Object.values(history.messages)
				.filter((message) => message.parentId === null)
				.map((message) => message.id);
			let messageId =
				childrenIds[Math.min(childrenIds.indexOf(message.id) + 1, childrenIds.length - 1)];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		}
	};

	const editMessage = async (messageId, { content, files }, submit = true) => {
		if (!selectedModels[0]) {
			toast.error($i18n.t('Model not selected'));
			return;
		}
		if (history.messages[messageId].role === 'user') {
			if (submit) {
				let userPrompt = content;
				let userMessageId = uuidv7();

				let userMessage = {
					id: userMessageId,
					parentId: history.messages[messageId].parentId,
					childrenIds: [],
					role: 'user',
					content: userPrompt,
					...(files && { files: files }),
					models: selectedModels,
					timestamp: Math.floor(Date.now() / 1000)
				};

				let messageParentId = history.messages[messageId].parentId;

				if (messageParentId !== null) {
					history.messages[messageParentId].childrenIds = [
						...history.messages[messageParentId].childrenIds,
						userMessageId
					];
				}

				history.messages[userMessageId] = userMessage;
				history.currentId = userMessageId;

				await tick();
				await sendMessage(history, userMessageId);
			} else {
				history.messages[messageId].content = content;
				history.messages[messageId].files = files;
				await updateChat();
			}
		} else {
			if (submit) {
				const responseMessageId = uuidv7();
				const message = history.messages[messageId];
				const parentId = message.parentId;

				const responseMessage = {
					...message,
					id: responseMessageId,
					parentId: parentId,
					childrenIds: [],
					files: undefined,
					content: content,
					timestamp: Math.floor(Date.now() / 1000)
				};

				history.messages[responseMessageId] = responseMessage;
				history.currentId = responseMessageId;

				if (parentId !== null) {
					history.messages[parentId].childrenIds = [
						...history.messages[parentId].childrenIds,
						responseMessageId
					];
				}

				await updateChat();
			} else {
				history.messages[messageId].originalContent = history.messages[messageId].content;
				history.messages[messageId].content = content;
				await updateChat();
			}
		}
	};

	const deleteMessage = async (messageId) => {
		const parentMessageId = history.messages[messageId]?.parentId ?? null;
		const next = deleteMessageInHistory(history, messageId);
		history.messages = next.messages;
		history.currentId = next.currentId;

		showMessage({ id: parentMessageId });
	};
</script>

<div class={className}>
	{#if Object.keys(history?.messages ?? {}).length == 0}
		<ChatPlaceholder modelIds={selectedModels} {onSelect} />
	{:else}
		<div class="w-full pt-2">
			{#key chatId}
				<section class="w-full" aria-labelledby="chat-conversation">
					<h2 class="sr-only" id="chat-conversation">{$i18n.t('Chat Conversation')}</h2>
					{#if firstMessage?.parentId !== null}
						<Loader
							onvisible={() => {
								console.log('visible');
								if (!messagesLoading) {
									loadMoreMessages();
								}
							}}
						>
							<div class="w-full flex justify-center py-1 text-xs animate-pulse items-center gap-2">
								<Spinner className=" size-4" />
								<div class=" ">{$i18n.t('Loading...')}</div>
							</div>
						</Loader>
					{/if}
					<ul role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false">
						{#each messageIds as messageId, messageIdx (messageId)}
							<Message
								{chatId}
								bind:history
								{streamingMessages}
								{messageId}
								idx={messageIdx}
								{user}
								{setInputText}
								{showPreviousMessage}
								{showNextMessage}
								{updateChat}
								{editMessage}
								{deleteMessage}
								{submitMessage}
								{regenerateResponse}
								{continueResponse}
								{addMessages}
								{readOnly}
								{topPadding}
							/>
						{/each}
					</ul>
				</section>
				<div class="pb-18" />
				{#if bottomPadding}
					<div class="  pb-6" />
				{/if}
			{/key}
		</div>
	{/if}
</div>
