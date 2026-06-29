const Constants = {
	MODULE_ID: 'wm5e',
	MODULE_NAME: 'Weapon Masteries 5e',
	GM_CREATE_EFFECTS: 'wm5e.createEffectsQuery',
	ROLL_SAVE: 'wm5e.rollSaveQuery',
	PUSH: 'wm5e.pushToken',
};

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let WM_REFERENCES;
let LISTENERS_REGISTERED = false;
const PENDING_AUTO_MASTERY_CONTEXT = new Map();
const PENDING_AUTO_MASTERY_MAX_AGE_MS = 60000;
const RSR_MASTERY_LINKS = new Map();

const WM_ACTIONS = {
	Cleave: async (data) => doCleave(data),
	Graze: async (data) => doGraze(data),
	Nick: async (data) => doNick(data),
	Push: async (data) => doPush(data),
	Sap: async (data) => doSap(data),
	Slow: async (data) => doSlow(data),
	Topple: async (data) => doTopple(data),
	Vex: async (data) => doVex(data),
};

function i18n(key) {
	return game.i18n.localize(`WM5E.${key}`);
}

function effectName(key) {
	return i18n(`Effects.${key}`);
}

Hooks.on('init', () => {
	registerQueries();
	registerSettings();
});

Hooks.on('ready', () => {
	WM_REFERENCES = CONFIG.DND5E.weaponMasteries;
	if (LISTENERS_REGISTERED) return;
	document.addEventListener('click', onActionsClick, { capture: true });
	document.addEventListener('auxclick', onActionsClick, { capture: true });
	document.addEventListener('contextmenu', onActionsClick, { capture: true, passive: false });
	LISTENERS_REGISTERED = true;
});
Hooks.on('renderItemSheet5e', (...args) => onRenderItemSheet(...args));
Hooks.on('dnd5e.preRollAttack', (...args) => doPreRollAttack(args));
Hooks.on('dnd5e.postRollAttack', (...args) => doAutoMasteries(...args, 'attack'));
Hooks.on('dnd5e.rollDamage', (...args) => doAutoMasteries(...args, 'damage'));
Hooks.on('rsreforged.preRenderChatMessageContent', (...args) => onRsrPreRenderChatMessageContent(...args));
Hooks.on('rsreforged.renderRoll', (...args) => onRsrRenderRoll(...args));

function doPreRollAttack(args) {
	const [config, dialog] = args;
	if (config.wm5e) {
		config.mastery = '';
		config.wm5eNoMastery = true;
		dialog.options.masteryOptions = [];
	}
}

async function doAutoMasteries() {
	if (!isAutoMasteriesEnabled()) return;
	prunePendingAutoMasteryContext();
	const [rolls, activityContext, action] = arguments;
	if (rolls?.some((roll) => roll.options?.wm5eNoMastery)) return;
	const activity = getHookSubject(activityContext);
	const midiActive = game.modules.get('midi-qol')?.active ?? false;
	const rsrActive = game.modules.get('rsreforged')?.active ?? false;
	const pendingContext = activity?.uuid ? PENDING_AUTO_MASTERY_CONTEXT.get(activity.uuid) : null;
	logRsrMasteryDebug('start', { action, rolls, activity, midiActive, rsrActive, pendingContext });
	let attackMessage;
	let mastery;
	let attackResult;

	if (midiActive || rsrActive) {
		mastery = rolls?.[0]?.options?.mastery ?? pendingContext?.mastery ?? '';
		attackResult = action === 'attack' ? summarizeAttackResult(rolls?.[0]) : pendingContext?.attackResult;
		attackMessage = pendingContext?.messageId ? game.messages.get(pendingContext.messageId) : null;
		if (activity?.uuid && action === 'attack' && (mastery || attackResult)) {
			PENDING_AUTO_MASTERY_CONTEXT.set(activity.uuid, {
				mastery,
				messageId: attackMessage?.id ?? pendingContext?.messageId ?? null,
				attackResult,
				timestamp: Date.now(),
			});
		}
		if (!attackMessage) attackMessage = await findRelevantMessageForActivity(activity);
		if (activity?.uuid && (mastery || attackMessage?.id || attackResult)) {
			PENDING_AUTO_MASTERY_CONTEXT.set(activity.uuid, {
				mastery: mastery || pendingContext?.mastery || '',
				messageId: attackMessage?.id ?? pendingContext?.messageId ?? null,
				attackResult: attackResult ?? pendingContext?.attackResult ?? null,
				timestamp: Date.now(),
			});
		}
	} else {
		const originatingMessageId = rolls?.[0]?.parent?.flags?.dnd5e?.originatingMessage;
		attackMessage = getOriginatingAttackMessage(originatingMessageId);
		mastery = attackMessage?.flags?.dnd5e?.roll?.mastery;
		attackResult = summarizeAttackResult(attackMessage?.rolls?.[0]);
	}

	logRsrMasteryDebug('resolved', { action, mastery, attackMessage, attackResult, activity, midiActive, rsrActive, pendingContext });

	if (!attackMessage && !attackResult) {
		logRsrMasteryDebug('return-no-attack', { action, mastery, attackMessage, attackResult, activity, midiActive, rsrActive, pendingContext });
		return;
	}

	if (!mastery) {
		logRsrMasteryDebug('return-no-mastery', { action, mastery, attackMessage, attackResult, activity, midiActive, rsrActive, pendingContext });
		return;
	}
	const { isCritical, isFailure, isFumble, isSuccess, isHit, isMiss } = attackResult ?? summarizeAttackResult(attackMessage?.rolls?.[0]);

	const messageEl = attackMessage?.id ? document.querySelector(`[data-message-id="${attackMessage.id}"]`) : null;
	const el = findMasteryAnchor(messageEl, mastery);

	const shouldTrigger = (action === 'attack' && isMiss && mastery === 'graze') || (action === 'damage' && isHit && ['cleave', 'push', 'sap', 'slow', 'topple', 'vex', 'nick'].includes(mastery));
	logRsrMasteryDebug('decision', { action, mastery, attackMessage, messageEl, el, isHit, isMiss, shouldTrigger });
	if (shouldTrigger) {
		logRsrMasteryDebug('trigger', { action, mastery, attackMessage, messageEl, el, isHit, isMiss });
		const target = game.modules.get('rsreforged')?.active ? await waitForRsrMasteryAnchor(attackMessage, mastery) : { message: attackMessage, el };
		logRsrMasteryDebug('target', { mastery, attackMessage, targetMessage: target.message, el: target.el });
		const used = await WM_ACTIONS[toMasteryLabel(mastery)]?.({ message: target.message, shiftKey: false, el: target.el });
		logRsrMasteryDebug('used', { mastery, used, targetMessage: target.message, el: target.el });
		if (used) markUsed(target.el);
	}
	if ((midiActive || rsrActive) && activity?.uuid && (action === 'damage' || shouldTrigger)) {
		PENDING_AUTO_MASTERY_CONTEXT.delete(activity.uuid);
	}
}

function getOriginatingAttackMessage(messageId) {
	const attackMessage = dnd5e.registry.messages.get(messageId)?.findLast((m) => m.flags.dnd5e?.roll?.type === 'attack');
	return attackMessage;
}

function getHookSubject(context) {
	return context?.subject ?? context ?? null;
}

function onRsrPreRenderChatMessageContent(message, html, type) {
	if (type !== 'activity' && type !== 'attack') return;
	const links = html.find('a.wm5e-mastery-reference').detach();
	if (!links.length) return;
	RSR_MASTERY_LINKS.set(getRsrTargetMessage(message)?.id ?? message.id, links);
}

function onRsrRenderRoll(message, html, rollType, sectionHtml) {
	if (rollType !== 'attack') return;
	const links = RSR_MASTERY_LINKS.get(message.id);
	if (!links?.length) return;
	sectionHtml.find('a.wm5e-mastery-reference').remove();
	sectionHtml.append(links.clone(true));
}

function getRsrTargetMessage(message) {
	const origin = message.getOriginatingMessage?.();
	if (origin && origin !== message) return origin;
	const associated = message.getAssociatedMessage?.();
	if (associated && associated !== message) return associated;
	return game.messages.get(message.flags?.dnd5e?.originatingMessage) ?? game.messages.get(message.system?.message) ?? message;
}

function logRsrMasteryDebug(step, data) {
	globalThis.wm5e ??= {};
	if (!globalThis.wm5e.rsrDebug) return;
	const message = data.attackMessage ?? data.targetMessage;
	console.log(`WM5E RSR ${step}: ${JSON.stringify({
		action: data.action,
		attempt: data.attempt,
		mastery: data.mastery,
		rsrActive: data.rsrActive ?? game.modules.get('rsreforged')?.active ?? false,
		midiActive: data.midiActive,
		shouldTrigger: data.shouldTrigger,
		used: data.used,
		isHit: data.isHit,
		isMiss: data.isMiss,
		attackResult: data.attackResult ? {
			isCritical: data.attackResult.isCritical,
			isFailure: data.attackResult.isFailure,
			isFumble: data.attackResult.isFumble,
			isSuccess: data.attackResult.isSuccess,
			total: data.attackResult.total,
		} : null,
		rollCount: data.rolls?.length,
		rollMastery: data.rolls?.[0]?.options?.mastery,
		rollOriginatingMessage: data.rolls?.[0]?.parent?.flags?.dnd5e?.originatingMessage,
		activityUuid: data.activity?.uuid,
		pendingMessageId: data.pendingContext?.messageId,
		pendingMastery: data.pendingContext?.mastery,
		messageId: message?.id,
		messageType: message?.flags?.dnd5e?.roll?.type,
		messageMastery: message?.flags?.dnd5e?.roll?.mastery,
		originatingMessage: message?.flags?.dnd5e?.originatingMessage,
		systemMessage: message?.system?.message,
		hasMessageEl: !!data.messageEl,
		hasAnchor: !!data.el,
		anchorText: data.el?.textContent?.trim(),
		anchorUuid: data.el?.dataset?.uuid,
		anchorRsrMastery: data.el?.closest('[data-rsr-generated-mastery]')?.dataset?.rsrGeneratedMastery,
	})}`);
}

async function waitForRsrMasteryAnchor(message, mastery, attempts = 6, delayMs = 50) {
	let targetMessage = message;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		targetMessage = getRsrTargetMessage(message);
		const messageEl = targetMessage?.id ? document.querySelector(`[data-message-id="${targetMessage.id}"]`) : null;
		const el = findMasteryAnchor(messageEl, mastery);
		logRsrMasteryDebug('wait', { mastery, targetMessage, messageEl, el, attempt });
		if (el) return { message: targetMessage, el };
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return { message: targetMessage, el: null };
}

function summarizeAttackResult(roll) {
	if (!roll) return null;
	const { isCritical = false, isFailure = false, isFumble = false, isSuccess = false } = roll;
	return { isCritical, isFailure, isFumble, isSuccess, isHit: isCritical || (isSuccess && !isFumble), isMiss: isFumble || (isFailure && !isCritical) };
}

function prunePendingAutoMasteryContext(now = Date.now()) {
	for (const [activityUuid, context] of PENDING_AUTO_MASTERY_CONTEXT.entries()) {
		if (now - (context?.timestamp ?? 0) <= PENDING_AUTO_MASTERY_MAX_AGE_MS) continue;
		PENDING_AUTO_MASTERY_CONTEXT.delete(activityUuid);
	}
}

async function findRelevantMessageForActivity(activity, attempts = 6, delayMs = 25) {
	if (!activity?.uuid) return null;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const message = getRecentRelevantMessageForActivity(activity);
		if (message) return message;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return null;
}

function getRecentRelevantMessageForActivity(activity) {
	if (!activity?.uuid) return null;
	const messages = game.messages?.contents ?? [];
	let activityMatch = null;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.flags?.dnd5e?.activity?.uuid !== activity.uuid) continue;
		if (message?.flags?.dnd5e?.roll?.type === 'attack') return message;
		if (message?.rolls?.[0]?.options?.rollType === 'attack') return message;
		activityMatch ||= message;
	}
	return activityMatch;
}

async function onActionsClick(event) {
	let el = event.target;

	if (el.tagName !== 'A') {
		el = el.closest('a');
		if (!el) return;
	}

	if (el.classList?.contains('wm5e-mastery-reference')) {
		if (event.type === 'contextmenu') {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (event.type === 'click') {
			event.preventDefault();
			event.stopPropagation();
			return toggleMasteryReference(el.dataset?.uuid, el.dataset?.hash ?? null);
		}
		if (event.type !== 'auxclick' || event.button !== 2) return;
		event.preventDefault();
		event.stopPropagation();
		return closeMasteryReference(el.dataset?.uuid);
	}

	const shiftKey = event.shiftKey;
	const tooltip = el.dataset?.tooltip;
	const uuid = el.dataset?.uuid;
	const term = Object.keys(WM_ACTIONS).find((key) => uuid === getMasteryReference(key.toLowerCase()));
	const messageId = el?.closest?.('[data-message-id]')?.dataset?.messageId ?? event?.currentTarget?.dataset?.messageId;
	const message = game.messages.get(messageId);

	if (!message?.isOwner || (!tooltip && !term)) return;

	if (event.type === 'contextmenu') {
		event.preventDefault();
		event.stopPropagation();
		return;
	}

	if (event.type === 'auxclick' && event.button === 2) {
		// if the user right clicks, reinstate the original left click open Journal action
		event.preventDefault();
		event.stopPropagation();

		const JournalEntry = await fromUuid(uuid);
		const target = el.closest('a[data-link]') ?? el;
		const anchor = target?.dataset?.hash ?? null;
		const sheet = JournalEntry?.parent?.sheet;
		if (sheet?.rendered) return sheet.close({ force: true });
		else return sheet?.render(true, { pageId: JournalEntry.id, anchor });
	}
	if (event.type !== 'click') return;
	const wmAction = WM_ACTIONS[tooltip] || WM_ACTIONS[term];

	if (!wmAction) return;

	event.preventDefault();
	event.stopPropagation();

	const used = await wmAction({ message, shiftKey, el });
	if (used) markUsed(el);
	return;
}

function onRenderItemSheet(app, html) {
	const masterySelects = html.querySelectorAll('select[name="system.mastery"]');
	for (const select of masterySelects) {
		ensureMasteryLink(select);
		syncMasteryLink(select);
		if (select.dataset.wm5eMasteryBound === 'true') continue;
		select.addEventListener('change', () => syncMasteryLink(select));
		select.dataset.wm5eMasteryBound = 'true';
	}
}

function ensureMasteryLink(select) {
	const parent = select?.parentElement;
	if (!parent) return null;
	parent.classList.add('wm5e-mastery-field');
	let link = parent.querySelector('.wm5e-mastery-link');
	if (link) return link;

	link = document.createElement('a');
	link.className = 'wm5e-mastery-link wm5e-mastery-reference content-link';
	link.setAttribute('draggable', 'true');
	link.dataset.link = '';
	link.setAttribute('aria-label', 'Open weapon mastery reference');
	link.innerHTML = '<i class="fas fa-book-open" aria-hidden="true"></i>';
	parent.append(link);
	return link;
}

function syncMasteryReferenceElement(el, masteryKey, uuid) {
	const label = toMasteryLabel(masteryKey);
	const docType = uuid.startsWith('JournalEntryPage.') ? 'JournalEntryPage' : 'JournalEntry';
	el.dataset.uuid = uuid;
	el.dataset.tooltip = label;
	el.dataset.link = '';
	el.dataset.type = docType;
	el.setAttribute('aria-label', `${label} reference`);
	el.setAttribute('data-tooltip-direction', 'UP');
}

function syncMasteryLink(select) {
	const link = ensureMasteryLink(select);
	if (!link) return;

	const masteryKey = select?.value;
	const label = toMasteryLabel(masteryKey);
	const uuid = getMasteryReference(masteryKey);

	if (!masteryKey || !uuid) {
		link.hidden = true;
		delete link.dataset.uuid;
		delete link.dataset.tooltip;
		delete link.dataset.hash;
		return;
	}

	const docType = uuid.startsWith('JournalEntryPage.') ? 'JournalEntryPage' : 'JournalEntry';
	link.hidden = false;
	link.dataset.uuid = uuid;
	link.dataset.tooltip = label;
	link.dataset.link = '';
	link.dataset.type = docType;
	link.setAttribute('aria-label', `${label} reference`);
	link.setAttribute('data-tooltip-direction', 'UP');
}

async function openMasteryReference(uuid, anchor = null) {
	if (!uuid) return;
	const documentRef = await fromUuid(uuid);
	if (!documentRef) return;

	if (documentRef.documentName === 'JournalEntryPage') {
		const sheet = documentRef.parent?.sheet;
		return sheet?.render(true, { pageId: documentRef.id, anchor });
	}

	return documentRef.sheet?.render(true);
}

async function toggleMasteryReference(uuid, anchor = null) {
	if (!uuid) return;
	const documentRef = await fromUuid(uuid);
	if (!documentRef) return;
	const sheet = getMasteryReferenceSheet(documentRef);
	if (sheet?.rendered) return sheet.close({ force: true });
	return openMasteryReference(uuid, anchor);
}

async function closeMasteryReference(uuid) {
	if (!uuid) return;
	const documentRef = await fromUuid(uuid);
	if (!documentRef) return;
	const sheet = getMasteryReferenceSheet(documentRef);
	if (!sheet?.rendered) return;
	return sheet.close({ force: true });
}

function getMasteryReferenceSheet(documentRef) {
	if (!documentRef) return null;
	if (documentRef.documentName === 'JournalEntryPage') return documentRef.parent?.sheet ?? null;
	return documentRef.sheet ?? null;
}

function gridUnitDistance() {
	return canvas?.grid?.distance || 5;
}

function getActivityDamageType(activity, attackRoll) {
	const defaultDamageType = attackRoll?.options?.['automated-conditions-5e']?.options?.defaultDamageType;
	if (defaultDamageType && typeof defaultDamageType === 'object') {
		const [type] = Object.keys(defaultDamageType);
		if (type) return type;
	}

	for (const part of activity?.damage?.parts ?? []) {
		if (part?.type) return part.type;
		if (part?.types instanceof Set) {
			const [type] = part.types;
			if (type) return type;
		}
		if (Array.isArray(part?.types) && part.types.length) return part.types[0];
	}

	const baseTypes = activity?.item?.system?.damage?.base?.types;
	if (baseTypes instanceof Set) {
		const [type] = baseTypes;
		if (type) return type;
	}
	if (Array.isArray(baseTypes) && baseTypes.length) return baseTypes[0];

	return null;
}

function setTargets(targetIds, { mode = 'replace' } = {}) {
	return canvas.tokens.setTargets(targetIds, { mode });
}

const TARGET_DIALOG_SELECTOR = '.application.dialog.wm5e-target-dialog';

async function prepareTargetSelectionData(targets) {
	const preparedTargets = [];
	for (const t of targets) {
		let img = t.document.texture.src;
		if (foundry.helpers.media.VideoHelper.hasVideoExtension(img)) {
			img = (await game.video?.createThumbnail(img, { width: 50, height: 50 })) ?? '';
		}
		preparedTargets.push({ id: t.id, name: t.name, img });
	}
	return preparedTargets;
}

function getLatestTargetDialogElement() {
	const dialogs = document.querySelectorAll(TARGET_DIALOG_SELECTOR);
	return dialogs[dialogs.length - 1] ?? null;
}

function decorateTargetDialog(dialogEl, preparedTargets) {
	if (!dialogEl || dialogEl.dataset.wm5eDecorated === 'true') return false;
	dialogEl.dataset.wm5eDecorated = 'true';

	dialogEl.addEventListener('pointerover', (ev) => {
		const btn = ev.target.closest('button');
		if (!btn || !dialogEl.contains(btn)) return;
		const id = btn.getAttribute('data-action');
		if (!id) return;
		setTargets([id]);
	});

	dialogEl.addEventListener('pointerout', (ev) => {
		const btn = ev.target.closest('button');
		if (!btn || !dialogEl.contains(btn)) return;
		setTargets([]);
	});

	for (const t of preparedTargets) {
		const btn = dialogEl.querySelector(`button[data-action="${t.id}"]`);
		if (!btn || btn.dataset.wm5eDecorated === 'true') continue;
		btn.dataset.wm5eDecorated = 'true';
		btn.classList.add('target-btn', `target-${t.id}`);
		btn.dataset.targetId = t.id;
		const img = document.createElement('img');
		img.src = t.img;
		img.alt = '';
		img.className = 'target-icon';
		btn.prepend(img);
	}

	return true;
}

function scheduleTargetDialogDecoration(preparedTargets, attempts = 8) {
	let remaining = attempts;
	const tryDecorate = () => {
		const dialogEl = getLatestTargetDialogElement();
		if (decorateTargetDialog(dialogEl, preparedTargets)) return;
		remaining -= 1;
		if (remaining > 0) requestAnimationFrame(tryDecorate);
	};
	requestAnimationFrame(tryDecorate);
}

async function promptTargetSelection(targets, multiple, title = 'Select Target') {
	const preparedTargets = await prepareTargetSelectionData(targets);
	const selectPromise = foundry.applications.api.DialogV2.wait({
		window: { title },
		content: `<p>Choose ${multiple} target(s):</p>`,
		modal: false,
		buttons: preparedTargets.map((t) => ({ label: t.name, action: t.id })),
		classes: ['wm5e', 'wm5e-target-dialog'],
	});
	scheduleTargetDialogDecoration(preparedTargets);
	const select = await selectPromise;
	if (!select) return false;
	await new Promise((resolve) => {
		setTimeout(() => {
			setTargets([select]);
			resolve();
		}, 15);
	});
	return canvas.tokens.get(select);
}

async function promptPushDistance(distances) {
	const gridUnits = canvas.grid?.units || '';
	const distance = await foundry.applications.api.DialogV2.wait({
		window: { title: 'Mastery: Push' },
		content: '<p class="wm5e-push-dialog-label">Choose Distance</p>',
		modal: false,
		classes: ['wm5e-push-dialog'],
		buttons: distances.map((distance) => ({ label: `${distance} ${gridUnits}`.trim(), action: String(distance) })),
	});
	return Number(distance) || 0;
}

function createMessageConfig({ activity, target, type = 'damage', rolls, flavor }) {
	const messageConfig = {};
	messageConfig.speaker = ChatMessage.implementation.getSpeaker({ token: activity.getUsageToken() });
	messageConfig.flavor = flavor || 'a';
	const flags = { dnd5e: {} };
	flags.dnd5e.roll = { type };
	const { item } = activity;
	flags.dnd5e.item = {
		type: item.type,
		id: item.id,
		uuid: item.uuid,
	};
	flags.dnd5e.activity = {
		type: activity.type,
		id: activity.id,
		uuid: activity.uuid,
	};
	flags.dnd5e.targets = [
		{
			name: target.name,
			uuid: target.actor.uuid,
			ac: target.actor.system.attributes.ac.value,
		},
	];
	messageConfig.flags = flags;
	if (rolls) messageConfig.rolls = rolls;
	return messageConfig;
}

function getMessageData(message) {
	if (!message) return;
	const dnd5eFlags = message.flags?.dnd5e ?? {};
	const activityUuid = dnd5eFlags.activity?.uuid;
	const itemUuid = dnd5eFlags.item?.uuid;
	const { originatingMessage, roll, targets } = dnd5eFlags;
	const { speaker, rolls: attackRolls, isAuthor, speakerActor: attacker, author } = message;

	const attackerToken = canvas.tokens.get(speaker.token);
	const target = fromUuidSync(targets?.[0]?.uuid);
	const targetToken = target?.token?.object || canvas.tokens.get(ChatMessage.getSpeaker({ actor: target })?.token);
	const activity = fromUuidSync(activityUuid);
	const item = fromUuidSync(itemUuid);
	return { message, attacker, attackerToken, target, targetToken, activity, item, originatingMessage, attackRolls, roll, isAuthor, author };
}

function getActionContext({ message, shiftKey, requireFailure, requireSuccess, warning }) {
	const data = getMessageData(message);
	if (!data) return null;

	const { attackRolls } = data;
	const attackRoll = attackRolls?.[0];
	if (!attackRoll) return null;

	const { isHit, isMiss } = summarizeAttackResult(attackRoll);

	if (!shiftKey && ((requireSuccess && isMiss) || (requireFailure && isHit))) {
		ui.notifications.warn(i18n(warning));
		return null;
	};

	return { ...data, attackRoll };
}

async function doCleave({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireSuccess: true, warning: 'Notifications.CleaveRequiresSuccess' });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item, originatingMessage, isAuthor } = context;
	if (!attackerToken || !targetToken || !activity) return false;

	const range = activity.range.reach || gridUnitDistance();

	const inRangeAttacker = ac5e.checkNearby(attackerToken, '!ally', range);
	const inRangeTarget = ac5e.checkNearby(targetToken, 'all', gridUnitDistance());
	const validTargets = inRangeAttacker.filter((t1) => inRangeTarget.some((t2) => t2.id === t1.id));

	if (!validTargets.length) {
		ui.notifications.warn(i18n('Notifications.CleaveNoTargetsInRange'));
		return false;
	}

	if (validTargets.length === 1) setTargets(validTargets);
	const cleaveTarget = await promptTargetSelection(validTargets, 1, 'Select target for Cleave.');
	if (!cleaveTarget) {
		ui.notifications.info(i18n('Notifications.NoTargets'));
		return false;
	}
	const mod = attacker.system.abilities[activity.ability ?? 'str'].mod;
	const useMod = mod < 0;
	let cleaveAttackRolls, workflow;
	const midiActive = game.modules.get('midi-qol')?.active;
	if (midiActive) {
		workflow = new MidiQOL.Workflows.Workflow(attacker, activity, ChatMessage.implementation.getSpeaker({ token: attackerToken }), new Set([cleaveTarget]), {});
		workflow.targetDescriptors = getTargetDescriptors();
		workflow.wm5e = true;
		cleaveAttackRolls = await activity.rollAttack({ workflow });
		await cleaveAttackRolls?.[0]?.toMessage(createMessageConfig({ activity, target: cleaveTarget, type: 'attack' }));
	} else cleaveAttackRolls = await activity.rollAttack({ wm5e: true, wm5eNoMastery: true });
	if (cleaveAttackRolls?.[0]?.isSuccess) {
		const config = {
			attackMode: 'offhand',
			isCritical: cleaveAttackRolls[0].isCritical,
		};
		if (midiActive) {
			workflow.attackMode = 'offhand';
			workflow.isCritical = cleaveAttackRolls[0].isCritical;
			config.workflow = workflow;
			const cleaveDamageRolls = await activity.rollDamage(config);
			const messageConfig = createMessageConfig({ activity, target: cleaveTarget, type: 'damage', rolls: cleaveDamageRolls });
			await ChatMessage.implementation.create(messageConfig);
		} else await activity.rollDamage(config);
	}
	await setTargets([targetToken.id]);
	return true;
}

async function doGraze({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireFailure: true, warning: 'Notifications.GrazeRequiresFailure' });
	if (!context) return false;
	const { attacker, attackerToken, targetToken, activity, attackRoll } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const abilityId = activity.ability ?? 'str';
	const ability = attacker?.system?.abilities?.[abilityId];
	if (!ability) return false;
	const mod = ability.mod;
	if (mod <= 0) {
		ui.notifications.warn(i18n('Notifications.GrazeRequiresPositiveModifier'));
		return false;
	}
	const damageType = getActivityDamageType(activity, attackRoll);
	const options =
		damageType ?
			{
				type: damageType,
				appearance: { colorset: damageType },
			}
		:	{};
	await new CONFIG.Dice.DamageRoll(String(mod), attacker.getRollData(), options).toMessage(createMessageConfig({ activity, target: targetToken, flavor: `${activity.item.name} - Graze`, type: 'damage' }));
	return true;
}

async function doNick({ message, shiftKey, el }) {
	const { attackerToken } = getMessageData(message) || {};
	if (!attackerToken) return false;
	const { text: { content } = {} } = await fromUuid(getMasteryReference('nick'));
	const speaker = ChatMessage.implementation.getSpeaker({ token: attackerToken });
	await ChatMessage.implementation.create({ content, speaker, flavor: 'Mastery Nick' });
	return true;
}

async function doPush({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireSuccess: true, warning: 'Notifications.PushRequiresSuccess' });
	if (!context) return false;
	const { attacker, attackerToken, targetToken, target, activity } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const targetTokenSize = Math.max(targetToken.document.width, targetToken.document.height);
	if (targetTokenSize > 2 && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.PushSizeLimit'));
		return false;
	}
	const { angle } = new foundry.canvas.geometry.Ray(attackerToken, targetToken);
	const direction = Math.normalizeDegrees(Math.toDegrees(angle));
	const positions = new Map();
	for (const distance of [1, 2].map((multiplier) => multiplier * (canvas.grid?.distance || 5))) {
		const position = getPushPosition(targetToken, direction, (distance / (canvas.grid?.distance || 5)) * gridUnitDistance());
		if (position) positions.set(distance, position);
	}
	if (!positions.size) {
		ui.notifications.warn(i18n('Notifications.PushNoSpace'));
		return false;
	}
	const pushDistance = await promptPushDistance([...positions.keys()]);
	if (!pushDistance) return false;
	const finalPosition = positions.get(pushDistance);
	let pushed;
	if (target.isOwner) pushed = await targetToken.document.update(finalPosition);
	else pushed = await doQueries('push', { tokenUuid: targetToken.document.uuid, updates: finalPosition });
	if (!pushed) return false;
	return true;
}

function getPushPosition(targetToken, direction, maxDistance) {
	for (const offset of [0, 45, -45]) {
		const point = canvas.grid.getTranslatedPoint(targetToken, direction + offset, maxDistance);
		const snapped = targetToken.getSnappedPosition(point);
		const path = targetToken.findMovementPath([{ x: targetToken.x, y: targetToken.y }, snapped], {});
		if (path.result.length > 1) return path.result.at(-1);
	}
	return null;
}

async function doSap({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireSuccess: true, warning: 'Notifications.SapRequiresSuccess' });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	if (target.appliedEffects.some((ae) => ae.name === effectName('Sap') && ae.origin === item.uuid)) {
		ui.notifications.warn(i18n('Notifications.SapAlreadyApplied'));
		return false;
	}
	const effectData = {
		name: effectName('Sap'),
		img: 'icons/skills/wounds/injury-face-impact-orange.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { expiry: 'turnStart', value: 1, units: 'turns' },
		start: {
			combatant: attackerToken.combatant?.id ?? null,
			combat: game.combat?.id ?? null,
			initiative: attackerToken.combatant?.initiative ?? null,
			round: game.combat?.round ?? null,
			turn: attackerToken.combatant?.turnNumber ?? null,
			time: game.time.worldTime,
		},
		changes: [{ key: 'flags.automated-conditions-5e.attack.disadvantage', mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: 'once;' }],
		flags: {
			wm5e: { source: 'Sap action' },
		},
	};
	if (attackerToken.combatant?.turnNumber > game.combat?.turn) effectData.duration.value = 0;
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return true;
}

async function doSlow({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireSuccess: true, warning: 'Notifications.SlowRequiresSuccess' });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	if (target.appliedEffects.some((ae) => ae.name === effectName('SlowWeaponMastery'))) {
		ui.notifications.warn(i18n('Notifications.SlowAlreadyApplied'));
		return false;
	}
	const movementTypes = Object.entries(target.system.attributes.movement).filter(([key, value]) => key !== 'hover' && value > 0);
	let changes;
	if (foundry.utils.isNewerVersion(game.system.version, '5.2.0')) changes = [{ key: 'system.attributes.movement.bonus', mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: -2 * gridUnitDistance() }];
	else changes = movementTypes.map(([key, value]) => ({ key: `system.attributes.movement.${key}`, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: -2 * gridUnitDistance() }));
	const effectData = {
		name: effectName('SlowWeaponMastery'),
		img: 'icons/magic/movement/chevrons-down-yellow.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { expiry: 'turnEnd', value: 1, units: 'turns' },
		start: {
			combatant: attackerToken.combatant?.id ?? null,
			combat: game.combat?.id ?? null,
			initiative: attackerToken.combatant?.initiative ?? null,
			round: game.combat?.round ?? null,
			turn: attackerToken.combatant?.turnNumber ?? null,
			time: game.time.worldTime,
		},
		changes,
		flags: {
			wm5e: { source: 'Slow action' },
		},
	};
	if (attackerToken.combatant?.turnNumber > game.combat?.turn) effectData.duration.value = 0;
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return true;
}

async function doTopple({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireSuccess: true, warning: 'Notifications.ToppleRequiresSuccess' });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	if (target.statuses.prone) {
		ui.notifications.warn(i18n('Notifications.ToppleAlreadyProne'));
		return false;
	}
	const ability = 'con';
	const dc = attacker.system.abilities[activity.ability ?? 'str'].dc;
	const saveRolls = await doQueries('rollSave', { actorUuid: target.uuid, ability, dc, flavor: `${item.name} - Topple Save` });
	if (saveRolls?.[0]?.total >= dc) return true;
	const effectData = foundry.utils.duplicate(await ActiveEffect.implementation.fromStatusEffect('prone'));
	effectData.origin = item.uuid;
	effectData.flags = effectData.flags || {};
	effectData.flags.wm5e = { source: 'Topple action' };
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData], { keepId: true });
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData], options: { keepId: true } });
	return true;
}

async function doVex({ message, shiftKey, el }) {
	const context = getActionContext({ message, shiftKey, requireSuccess: true, warning: 'Notifications.VexRequiresSuccess' });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	if (target.appliedEffects.some((ae) => ae.origin === item.uuid && ae.name === effectName('Vex'))) {
		ui.notifications.warn(i18n('Notifications.VexAlreadyApplied'));
		return false;
	}
	const effectData = {
		name: effectName('Vex'),
		img: 'icons/magic/symbols/chevron-elipse-circle-blue.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { expiry: 'turnEnd', value: 1, units: 'turns' },
		start: {
			combatant: attackerToken.combatant?.id ?? null,
			combat: game.combat?.id ?? null,
			initiative: attackerToken.combatant?.initiative ?? null,
			round: game.combat?.round ?? null,
			turn: attackerToken.combatant?.turnNumber ?? null,
			time: game.time.worldTime,
		},
		changes: [{ key: 'flags.automated-conditions-5e.grants.attack.advantage', mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: 'once; effectOriginTokenId === tokenId && hasAttack' }],
		flags: {
			wm5e: { source: 'Vex action' },
		},
	};
	if (attackerToken.combatant?.turnNumber > game.combat?.turn) effectData.duration.value = 0;
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return true;
}

async function doQueries(type, data) {
	const activeGM = game.users.activeGM;
	if (!activeGM) return false;
	try {
		if (type === 'createEffects') {
			return activeGM.query(Constants.GM_CREATE_EFFECTS, data);
		} else if (type === 'rollSave') {
			const actor = await fromUuid(data.actorUuid);
			const user = getPlayerForActor(actor);
			if (user?.active) return user.query(Constants.ROLL_SAVE, data);
			else return activeGM.query(Constants.ROLL_SAVE, data);
		} else if (type === 'push') {
			return activeGM.query(Constants.PUSH, data);
		}
		return true;
	} catch (err) {
		console.error(`${Constants.MODULE_NAME} | Error on the ${type} type GM query:`, err);
		return false;
	}
}

async function createEffects({ actorUuid, effects, options } = {}) {
	const actor = await fromUuid(actorUuid);
	return actor?.createEmbeddedDocuments('ActiveEffect', effects, options);
}

async function pushAction({ tokenUuid, updates }) {
	const token = await fromUuid(tokenUuid);
	return token?.update(updates);
}

async function rollSavingThrow({ actorUuid, ability, dc, flavor }) {
	const actor = await fromUuid(actorUuid);
	if (!actor) return false;
	return actor?.rollSavingThrow({ ability, target: dc }, {}, { data: { flavor } });
}

function registerQueries() {
	CONFIG.queries[Constants.MODULE_ID] = {};
	CONFIG.queries[Constants.GM_CREATE_EFFECTS] = createEffects;
	CONFIG.queries[Constants.ROLL_SAVE] = rollSavingThrow;
	CONFIG.queries[Constants.PUSH] = pushAction;
}

function getTargetDescriptors() {
	const targets = new Map();
	for (const token of game.user.targets) {
		const { name } = token;
		const { img, system, uuid, statuses } = token.actor ?? {};
		if (uuid) {
			const ac = statuses.has('coverTotal') ? null : system.attributes?.ac?.value;
			targets.set(uuid, { name, img, uuid, ac: ac ?? null });
		}
	}
	return Array.from(targets.values());
}

class Wm5eLinksMenu extends HandlebarsApplicationMixin(ApplicationV2) {
	static LINKS = [
		{ label: 'README', icon: 'fa-brands fa-github', url: 'https://github.com/thatlonelybugbear/wm5e/blob/main/README.md' },
		{ label: 'Issues', icon: 'fa-solid fa-circle-exclamation', url: 'https://github.com/thatlonelybugbear/wm5e/issues' },
		{ label: 'Discord', icon: 'fa-brands fa-discord', url: 'https://discord.gg/twsvWuJJEN' },
		{ label: 'Ko-Fi', icon: 'fa-solid fa-mug-hot', url: 'https://ko-fi.com/thatlonelybugbear' },
		{ label: 'Patreon', icon: 'fa-brands fa-patreon', url: 'https://www.patreon.com/thatlonelybugbear' },
	];

	static DEFAULT_OPTIONS = {
		id: 'wm5e-links-menu',
		classes: ['wm5e-links-menu'],
		window: {
			title: 'WM5E.LinksMenu.Title',
			icon: 'fa-solid fa-link',
			resizable: false,
		},
		actions: {
			openLink: Wm5eLinksMenu.#onOpenLink,
		},
		position: {
			width: 420,
			height: 'auto',
		},
	};

	static PARTS = {
		body: {
			template: 'modules/wm5e/templates/apps/wm5e-links-menu.hbs',
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		context.primaryLinks = this.constructor.LINKS.slice(0, 2);
		context.secondaryLinks = this.constructor.LINKS.slice(2, 3);
		context.tertiaryLinks = this.constructor.LINKS.slice(3);
		return context;
	}

	static #onOpenLink(_event, target) {
		const url = target?.dataset?.url;
		if (!url) return;
		globalThis.open(url, '_blank', 'noopener,noreferrer');
	}
}

function registerSettings() {
	game.settings.registerMenu(Constants.MODULE_ID, 'linksMenu', {
		name: 'WM5E.LinksMenu.Name',
		label: 'WM5E.LinksMenu.Label',
		hint: 'WM5E.LinksMenu.Hint',
		icon: 'fa-solid fa-link',
		type: Wm5eLinksMenu,
		restricted: false,
	});

	game.settings.register(Constants.MODULE_ID, 'autoMasteries', {
		name: 'WM5E.AutoMasteries.Name',
		hint: 'WM5E.AutoMasteries.Hint',
		scope: 'user',
		config: true,
		type: new foundry.data.fields.BooleanField({ initial: false }),
	});
}

function isAutoMasteriesEnabled() {
	return game.settings.get(Constants.MODULE_ID, 'autoMasteries');
}

// Resolve an active user who can respond to actor-targeted queries.
function getPlayerForActor(actor) {
	if (!actor) return undefined;
	const players = game.users?.players ?? [];
	const activePlayers = players.filter((p) => p.active);
	const ownership = actor.ownership ?? {};
	const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	const inheritLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.INHERIT;
	const hasOwnerPermission = (user) => {
		if (!user) return false;
		const explicitLevel = ownership[user.id];
		if (explicitLevel === ownerLevel) return true;
		if (explicitLevel !== undefined && explicitLevel !== inheritLevel) return false;
		return ownership.default === ownerLevel;
	};

	// Prefer the active player currently linked to this actor.
	let user = activePlayers.find((p) => p.character?.id === actor.id);
	if (user) return user;

	// Then any active player with owner permission.
	user = activePlayers.find(hasOwnerPermission);
	if (user) return user;

	// If all else fails, use any active GM.
	return game.users.activeGM ?? undefined;
}

function markUsed(el) {
	if (!el) return;

	if (!el.classList.contains('wm5e-used')) {
		const label = document.createElement('span');
		label.className = 'wm5e-used-label';
		while (el.firstChild) label.append(el.firstChild);
		el.append(label);
		el.classList.add('wm5e-used');
	}

	if (el.querySelector('.wm5e-used-note')) return;
	const usedNote = document.createElement('span');
	usedNote.className = 'wm5e-used-note';
	usedNote.textContent = '(used)';
	el.append(usedNote);
	return true;
}

function toMasteryLabel(masteryKey) {
	if (!masteryKey) return '';
	return `${masteryKey[0].toUpperCase()}${masteryKey.slice(1)}`;
}

function getMasteryReference(masteryKey) {
	return WM_REFERENCES?.[masteryKey]?.reference ?? WM_REFERENCES?.[masteryKey]?.uuid ?? '';
}

function findMasteryAnchor(root, masteryKey) {
	if (!root?.querySelector || !masteryKey) return null;
	const reference = getMasteryReference(masteryKey);
	if (reference) {
		const byUuid = root.querySelector(`a[data-uuid="${reference}"]`);
		if (byUuid) return byUuid;
	}
	if (game.modules.get('rsreforged')?.active) {
		const rsrAnchor = root.querySelector(`[data-rsr-generated-mastery="${masteryKey}"] a`);
		if (rsrAnchor) return rsrAnchor;
	}
	const label = toMasteryLabel(masteryKey);
	if (!label) return null;
	return root.querySelector(`a[data-tooltip="${label}"]`);
}
