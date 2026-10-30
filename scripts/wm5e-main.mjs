const Constants = {
	MODULE_ID: 'wm5e',
	MODULE_NAME: 'Weapon Masteries 5e',
	GM_CREATE_EFFECTS: 'wm5e.createEffectsQuery',
	UPDATE_EFFECT: 'wm5e.updateEffectQuery',
	ROLL_SAVE: 'wm5e.rollSaveQuery',
	PUSH: 'wm5e.pushToken',
	MARK_MASTERY_USED: 'wm5e.markMasteryUsed',
	CLAIM_MASTERY: 'wm5e.claimMastery',
};

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let WM_REFERENCES;
let LISTENERS_REGISTERED = false;
const PENDING_AUTO_MASTERY_CONTEXT = new Map();
const PENDING_AUTO_MASTERY_MAX_AGE_MS = 60000;
const RSR_MASTERY_LINKS = new Map();
const RSR_DEFERRED_ROLLS = new WeakSet();
const MASTERY_ROLL_CONTEXT = new WeakMap();
const MASTERY_DIALOG_POSITIONS = new WeakMap();
const MASTERY_CLAIMS = new Map();
const MASTERY_TURN_CLAIMS = new Map();
const MASTERY_ACTOR_UPDATES = new Map();
const REGISTERED_WEAPON_IDS = new Set();

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
	CONFIG.Token.movement.actions.wm5ePush = {
		label: 'DND5E.WEAPON.Mastery.Push',
		icon: 'fa-solid fa-hand',
		canSelect: false,
		measure: false,
		terrainAction: null,
		costMultiplier: 0,
	};
});

Hooks.on('ready', () => {
	WM_REFERENCES = CONFIG.DND5E.weaponMasteries;
	applyCustomWeaponIds();
	if (game.user === game.users.activeGM && !game.settings.storage.get('world').getSetting(`${Constants.MODULE_ID}.autoMasteriesUsers`)) {
		const users = game.users.filter((user) => isAutoMasteriesEnabled(user.id)).map((user) => user.id);
		game.settings.set(Constants.MODULE_ID, 'autoMasteriesUsers', users);
	}
	if (LISTENERS_REGISTERED) return;
	document.addEventListener('click', onActionsClick, { capture: true });
	document.addEventListener('auxclick', onActionsClick, { capture: true });
	document.addEventListener('contextmenu', onActionsClick, { capture: true, passive: false });
	LISTENERS_REGISTERED = true;
});
Hooks.on('renderItemSheet5e', (...args) => onRenderItemSheet(...args));
Hooks.on('userConnected', (user, connected) => {
	if (!connected) releaseAbandonedMasteryClaims(user.id);
});
Hooks.on('dnd5e.renderChatMessage', renderUsedMasteries);
Hooks.on('rsreforged.renderChatMessageContent', (message, html) => renderUsedMasteries(message, html[0] ?? html));
Hooks.on('updateChatMessage', (message, changes) => {
	if (!changes.flags?.wm5e?.usedMasteries && !changes.flags?.wm5e?.usedMasteryRows) return;
	for (const card of document.querySelectorAll(`[data-message-id="${message.id}"]`)) {
		const root = card.closest('.chat-message') ?? card;
		renderUsedMasteries(game.messages.get(root.dataset.messageId) ?? message, root);
	}
});
Hooks.on('renderSettingsConfig', (_app, html) => {
	if (!game.user.isGM) return;
	const input = html.querySelector('multi-select[name="wm5e.autoMasteriesUsers"]');
	const label = input?.closest('.form-group')?.querySelector('label');
	if (!label || label.querySelector('.wm5e-select-all')) return;
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'wm5e-select-all';
	button.textContent = i18n('AutoMasteries.SelectAll');
	button.title = i18n('AutoMasteries.SelectAll');
	button.setAttribute('aria-label', button.title);
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		input.value = game.users.map((user) => user.id);
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	label.append(button);
});
Hooks.on('dnd5e.preRollAttack', (...args) => doPreRollAttack(args));
Hooks.on('dnd5e.preRollDamage', (...args) => doPreRollDamage(args));
Hooks.on('dnd5e.preUseActivity', (_activity, config, dialog) => {
	const source = game.messages.get(config.event?.target?.closest?.('[data-message-id]')?.dataset.messageId);
	const position = getMasteryDialogPosition(config.event) ?? MASTERY_DIALOG_POSITIONS.get(source) ?? dialog.options?.position;
	if (position) MASTERY_DIALOG_POSITIONS.set(config, position);
});
Hooks.on('dnd5e.postUseActivity', (_activity, config, results) => {
	const position = MASTERY_DIALOG_POSITIONS.get(config);
	if (position && results.message) MASTERY_DIALOG_POSITIONS.set(results.message, position);
});
Hooks.on('dnd5e.postRollAttack', (...args) => doAutoMasteries(...args, 'attack'));
Hooks.on('dnd5e.rollDamage', (...args) => doAutoMasteries(...args, 'damage'));
Hooks.on('dnd5e.postRollConfiguration', (rolls, config, _dialog, message) => {
	const pendingContext = config.workflow && PENDING_AUTO_MASTERY_CONTEXT.get(config.workflow);
	if (pendingContext) pendingContext.timestamp = Date.now();
	const origin = game.messages.get(message.data?.system?.origin);
	const dialogPosition = config.wm5eDialogPosition ?? MASTERY_DIALOG_POSITIONS.get(getUsageMessage(origin) ?? origin) ?? _dialog.options?.position;
	if (dialogPosition && config.workflow) MASTERY_DIALOG_POSITIONS.set(config.workflow, dialogPosition);
	if (dialogPosition && pendingContext) pendingContext.dialogPosition = dialogPosition;
	for (const roll of rolls) {
		MASTERY_ROLL_CONTEXT.set(roll, { workflow: config.workflow, create: message.create, dialogPosition });
		if (message.create === false && message.data?.flags?.rsreforged?.workflowVersion === 2) RSR_DEFERRED_ROLLS.add(roll);
	}
});
Hooks.on('createChatMessage', (message, _options, userId) => {
	if (userId !== game.user.id || message.flags?.rsreforged?.workflowVersion !== 2 || !['attack', 'damage'].includes(message.type)) return;
	return doAutoMasteries(message.rolls, { subject: message.getAssociatedActivity?.(), message }, message.type);
});
Hooks.on('midi-qol.AttackRollComplete', (...args) => doMidiAttackRollComplete(args));
Hooks.on('midi-qol.preDamageRoll', (...args) => doMidiPreDamageRoll(args));
Hooks.on('rsreforged.preRenderChatMessageContent', (...args) => onRsrPreRenderChatMessageContent(...args));
Hooks.on('rsreforged.renderRoll', (...args) => onRsrRenderRoll(...args));

function doPreRollAttack(args) {
	const [config, dialog] = args;
	config.wm5eDialogPosition ??= getMasteryDialogPosition(config.event ?? config.workflow?.rollOptions?.event);
	if (config.wm5e || config.wm5eNoMastery) {
		config.mastery = '';
		config.wm5eNoMastery = true;
		setNoMasteryRollOptions(config);
		dialog.options ??= {};
		dialog.options.masteryOptions = [];
		return;
	}
	const item = config.subject?.item;
	if (item?.type !== 'weapon' || item.actor?.type !== 'npc' || !item.system.mastery || item.system.masteryOptions || !isNpcMasteriesEnabled()) return;
	config.mastery ??= item.system.mastery;
	for (const roll of config.rolls ?? []) {
		roll.options ??= {};
		roll.options.mastery = config.mastery;
	}
}

function doPreRollDamage(args) {
	const [config] = args;
	config.wm5eDialogPosition ??= getMasteryDialogPosition(config.event ?? config.workflow?.rollOptions?.event);
	if (config.wm5eNoMastery) {
		setNoMasteryRollOptions(config);
		if (config.workflow && !Array.isArray(config.workflow.targetDescriptors)) config.workflow.targetDescriptors = [];
	}
}

function setNoMasteryRollOptions(config) {
	for (const roll of config.rolls ?? []) {
		roll.options ??= {};
		roll.options.wm5eNoMastery = true;
	}
}

function doMidiPreDamageRoll(args) {
	if (!isAutoMasteriesEnabled()) return;
	const [workflow, activity, config] = args;
	const targetToken = getWorkflowTarget(workflow);
	if (!activity?.uuid || !(targetToken?.actor instanceof Actor)) return;
	const mastery = workflow?.attackRoll?.options?.mastery ?? '';
	const attackResult = getMidiAttackResult(workflow, targetToken);
	if (!attackResult) return;
	const context = {
		mastery,
		messageId: workflow?.itemCardId ?? workflow?.defaultItemCardUuid?.split('.').pop() ?? null,
		attackResult,
		attackRoll: workflow.attackRoll,
		dialogPosition: getMasteryDialogPosition(config?.event) ?? MASTERY_DIALOG_POSITIONS.get(workflow),
		targetActorUuid: targetToken.actor.uuid,
		targetTokenUuid: targetToken.document.uuid,
		timestamp: Date.now(),
	};
	workflow.automatedMasteries = {
		targetActor: context.targetActorUuid,
		targetToken: context.targetTokenUuid,
		isHit: attackResult.isHit,
		mastery,
	};
	PENDING_AUTO_MASTERY_CONTEXT.set(workflow, context);
}

async function doMidiAttackRollComplete(args) {
	if (!isAutoMasteriesEnabled()) return;
	prunePendingAutoMasteryContext();
	const [workflow] = args;
	if (workflow?.attackRoll?.options?.wm5eNoMastery) return;
	const activity = workflow?.activity;
	const targetToken = getWorkflowTarget(workflow);
	if (!activity?.uuid || !(targetToken?.actor instanceof Actor)) return;
	const mastery = workflow?.attackRoll?.options?.mastery ?? '';
	if (!mastery) return;
	const attackResult = getMidiAttackResult(workflow, targetToken);
	if (!attackResult) return;
	const attackMessage = workflow.chatCard ?? (workflow.itemCardId ? game.messages.get(workflow.itemCardId) : null);
	if (mastery === 'nick' && !isNickReminderEnabled()) return;
	const dialogPosition = MASTERY_ROLL_CONTEXT.get(workflow.attackRoll)?.dialogPosition ?? MASTERY_DIALOG_POSITIONS.get(workflow) ?? getMasteryDialogPosition(workflow.rollOptions?.event);
	PENDING_AUTO_MASTERY_CONTEXT.set(workflow, {
		dialogPosition,
		mastery,
		messageId: attackMessage?.id ?? null,
		attackResult,
		attackRoll: workflow.attackRoll,
		targetActorUuid: targetToken.actor.uuid,
		targetTokenUuid: targetToken.document.uuid,
		timestamp: Date.now(),
	});
	workflow.automatedMasteries = {
		targetActor: targetToken.actor.uuid,
		targetToken: targetToken.document.uuid,
		isHit: attackResult.isHit,
		mastery,
	};
	const shouldTrigger = (attackResult.isMiss && mastery === 'graze') || mastery === 'nick' || (attackResult.isHit && ['push', 'sap', 'topple'].includes(mastery));
	if (!shouldTrigger) return;
	await executeMastery({ message: attackMessage, attackMessage, mastery, attackRoll: workflow.attackRoll, targetToken, dialogPosition, rowId: getMidiAttackRowId(workflow), shiftKey: false, attackResult });
}

async function doAutoMasteries(rolls, activityContext, action) {
	if (!isAutoMasteriesEnabled() || rolls?.some((roll) => roll.options?.wm5eNoMastery)) return;
	prunePendingAutoMasteryContext();
	const rollContext = MASTERY_ROLL_CONTEXT.get(rolls?.[0]);
	if (!activityContext?.message && rolls?.some((roll) => RSR_DEFERRED_ROLLS.has(roll))) return;
	const midiActive = game.modules.get('midi-qol')?.active === true;
	if (midiActive && action === 'attack') return;
	// A non-created damage roll may be a reroll. Only Midi's explicit workflow can identify its attack.
	if (!activityContext?.message && rollContext?.create === false && !rollContext.workflow) return;
	const rollMessage = activityContext?.message ?? rolls?.[0]?.parent;
	if (action === 'attack' && rolls.length > 1 && rollMessage?.type === 'attack') {
		return Promise.all(rolls.map((roll, index) => doAutoMasteries([roll], { ...activityContext, message: rollMessage, rowId: getAttackRowId(rollMessage, index) }, action)));
	}
	const workflow = rollContext?.workflow ?? activityContext?.workflow;
	const pendingContext = workflow ? PENDING_AUTO_MASTERY_CONTEXT.get(workflow) : null;
	let attackMessage, attackRoll, rowId;
	if (midiActive && pendingContext) {
		attackMessage = game.messages.get(pendingContext.messageId);
		attackRoll = pendingContext.attackRoll;
		rowId = getMidiAttackRowId(workflow);
	} else {
		const reference = resolveAttackReference(rollMessage ?? game.messages.get(rolls?.[0]?.options?.originatingMessage), activityContext?.rowId);
		if (!reference) return;
		({ message: attackMessage, roll: attackRoll, rowId } = reference);
	}
	if (!attackMessage || !attackRoll) return;
	const mastery = midiActive ? attackRoll.options?.mastery : (attackMessage.system?.mastery ?? attackRoll.options?.mastery);
	if (!mastery) return;
	const attackResult = pendingContext?.attackResult ?? summarizeAttackResult(attackRoll);
	logRsrMasteryDebug('resolved', { action, mastery, attackMessage, attackResult, activity: getHookSubject(activityContext), midiActive, pendingContext });
	const { isHit, isMiss } = attackResult ?? {};
	const shouldTrigger =
		(action === 'attack' && ((isMiss && mastery === 'graze') || (mastery === 'nick' && isNickReminderEnabled()) || (isHit && ['push', 'sap', 'topple'].includes(mastery)))) ||
		(action === 'damage' && isHit && ['cleave', 'slow', 'vex'].includes(mastery));
	if (!shouldTrigger) return;
	const token = midiActive ? getTokenFromUuid(pendingContext?.targetTokenUuid) : null;
	const targets = action === 'damage' && rollMessage?.system?.targets?.length ? rollMessage.system.targets : undefined;
	const dialogPosition = activityContext?.dialogPosition ?? rollContext?.dialogPosition ?? pendingContext?.dialogPosition ?? MASTERY_DIALOG_POSITIONS.get(getUsageMessage(attackMessage) ?? attackMessage);
	await executeMastery({ message: attackMessage, attackMessage, mastery, attackRoll, targetToken: token, targets, dialogPosition, rowId, shiftKey: false, attackResult });
}

function getUsageMessage(message) {
	const seen = new Set();
	while (message && !seen.has(message.id)) {
		if (message.type === 'usage') return message;
		seen.add(message.id);
		message = message.getOriginatingMessage?.();
	}
	return null;
}

function getAttackRowId(message, index = 0) {
	return message.rolls?.[index]?.options?.bm5eAttackRowId ?? `${message.id}:${index}`;
}

function getMidiAttackRowId(workflow) {
	// The workflow survives attack rerolls; another activity use has a different workflow/card.
	const message = workflow.chatCard;
	if (message?.type === 'attack' && message.rolls?.length === 1) return getAttackRowId(message);
	return `midi:${message?.uuid ?? workflow.itemCardId ?? workflow.id}`;
}

function resolveAttackReference(message, rowId) {
	if (!message) return null;
	const association = message.type === 'damage' ? message.flags?.bm5e?.attackAssociation : undefined;
	if (association !== undefined) {
		if (association?.version !== 1 || !Array.isArray(association.attacks) || association.attacks.length !== 1) return null;
		const reference = association.attacks[0];
		const attack = game.messages.get(reference.messageId);
		if (attack?.type !== 'attack' || !getUsageMessage(message) || getUsageMessage(attack)?.id !== getUsageMessage(message)?.id) return null;
		return resolveAttackReference(attack, reference.rowId);
	}
	if (message.type !== 'attack') {
		if (game.modules.get('midi-qol')?.active) {
			const rolls = (message.rolls ?? []).filter((roll) => roll.options?.['midi-qol']?.rollType === 'attack');
			if (rolls.length === 1) return { message, roll: rolls[0], rowId: `midi:${message.uuid ?? message.id}` };
		}
		const origin = message.getOriginatingMessage?.();
		if (origin && origin !== message && origin.type === 'attack') return resolveAttackReference(origin, rowId);
		const usage = getUsageMessage(message) ?? message;
		const attacks = usage.getAssociatedRolls?.('attack') ?? dnd5e.registry.messages.get(usage.id, 'attack') ?? [];
		if (message.type === 'usage' && rowId != null) {
			const references = attacks.map((attack) => resolveAttackReference(attack, rowId)).filter(Boolean);
			return references.length === 1 ? references[0] : null;
		}
		// Never guess the latest row in a combined card.
		if (attacks.length !== 1 || attacks[0].rolls?.length !== 1) return null;
		const attack = attacks[0];
		if (message.type === 'damage' && ((attack.timestamp > message.timestamp) ||
			(message.system?.activity?.uuid && message.system.activity.uuid !== attack.system?.activity?.uuid))) return null;
		return resolveAttackReference(attack, rowId);
	}
	const index = rowId == null ? (message.rolls?.length === 1 ? 0 : -1) : message.rolls?.findIndex((_roll, i) => getAttackRowId(message, i) === rowId);
	if (!(index >= 0)) return null;
	return { message, roll: message.rolls[index], rowId: getAttackRowId(message, index) };
}

function getOriginatingAttackMessage(messageId) {
	const message = game.messages.get(messageId);
	return message?.type === 'attack' ? message : resolveAttackReference(message)?.message ?? null;
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
	if (!message) return null;
	const origin = message.getOriginatingMessage?.();
	if (origin && origin !== message) return origin;
	const associated = message.getAssociatedMessage?.();
	if (associated && associated !== message) return associated;
	return message;
}

function logRsrMasteryDebug(step, data) {
	globalThis.wm5e ??= {};
	if (!globalThis.wm5e.rsrDebug) return;
	const message = data.attackMessage ?? data.targetMessage;
	console.log(
		`WM5E RSR ${step}: ${JSON.stringify({
			action: data.action,
			attempt: data.attempt,
			mastery: data.mastery,
			rsrActive: data.rsrActive ?? game.modules.get('rsreforged')?.active ?? false,
			midiActive: data.midiActive,
			shouldTrigger: data.shouldTrigger,
			used: data.used,
			isHit: data.isHit,
			isMiss: data.isMiss,
			attackResult:
				data.attackResult ?
					{
						isCritical: data.attackResult.isCritical,
						isFailure: data.attackResult.isFailure,
						isFumble: data.attackResult.isFumble,
						isSuccess: data.attackResult.isSuccess,
						total: data.attackResult.total,
					}
				:	null,
			rollCount: data.rolls?.length,
			rollMastery: data.rolls?.[0]?.options?.mastery,
			rollOriginatingMessage: data.rolls?.[0]?.parent?.getOriginatingMessage?.()?.id,
			activityUuid: data.activity?.uuid,
			pendingMessageId: data.pendingContext?.messageId,
			pendingMastery: data.pendingContext?.mastery,
			messageId: message?.id,
			messageType: message?.type,
			messageMastery: message?.system?.mastery,
			originatingMessage: message?.getOriginatingMessage?.()?.id,
			hasMessageEl: !!data.messageEl,
			hasAnchor: !!data.el,
			anchorText: data.el?.textContent?.trim(),
			anchorUuid: data.el?.dataset?.uuid,
			anchorRsrMastery: data.el?.closest('[data-rsr-generated-mastery]')?.dataset?.rsrGeneratedMastery,
		})}`,
	);
}

function summarizeAttackResult(roll) {
	if (!roll) return null;
	const { isCritical = false, isFailure = false, isFumble = false, isSuccess = false } = roll;
	return { isCritical, isFailure, isFumble, isSuccess, isHit: isCritical || (isSuccess && !isFumble), isMiss: isFumble || (isFailure && !isCritical) };
}

function prunePendingAutoMasteryContext(now = Date.now()) {
	for (const [workflow, context] of PENDING_AUTO_MASTERY_CONTEXT.entries()) {
		if (now - (context?.timestamp ?? 0) <= PENDING_AUTO_MASTERY_MAX_AGE_MS) continue;
		PENDING_AUTO_MASTERY_CONTEXT.delete(workflow);
	}
}

async function onActionsClick(event) {
	if (event.type === 'click' && event.target.closest?.('button, [data-action]')) {
		const source = game.messages.get(event.target.closest('[data-message-id]')?.dataset.messageId);
		const position = source && getMasteryDialogPosition(event);
		if (position) {
			MASTERY_DIALOG_POSITIONS.set(source, position);
			const usage = getUsageMessage(source);
			if (usage) MASTERY_DIALOG_POSITIONS.set(usage, position);
		}
	}
	let el = event.target;

	el = el.closest('a');
	if (!el) return;

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

	if (!message || !canUseMastery(message, game.user) || (!tooltip && !term)) return;

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
	event.stopImmediatePropagation();

	const dialogPosition = getMasteryDialogPosition(event, el);
	const reference = await selectManualAttackReference(message, el.closest('[data-bm5e-attack-row-id]')?.dataset.bm5eAttackRowId, dialogPosition);
	if (!reference) return;
	await executeMastery({ message: reference.message, attackMessage: reference.message, mastery: (term ?? tooltip).toLowerCase(), attackRoll: reference.roll, rowId: reference.rowId, shiftKey, el, dialogPosition });
	return;
}

async function selectManualAttackReference(message, rowId, position) {
	const reference = resolveAttackReference(message, rowId);
	if (reference || message.type !== 'usage') return reference;
	const attacks = message.getAssociatedRolls?.('attack') ?? dnd5e.registry.messages.get(message.id, 'attack') ?? [];
	const references = attacks.flatMap((attack) => attack.rolls.map((_roll, index) => resolveAttackReference(attack, getAttackRowId(attack, index))));
	if (!references.length) return null;
	const selected = await foundry.applications.api.DialogV2.wait({
		window: { title: 'Select attack for mastery' },
		...(position ? { position } : {}),
		content: '<p>Choose the attack for this mastery.</p>',
		buttons: references.map(({ roll }, index) => ({ action: String(index), label: `Attack ${index + 1}: ${roll.total ?? ''}` })),
	});
	return typeof selected === 'string' ? references[Number(selected)] ?? null : null;
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

function getMasteryDialogPosition(event, element = event?.target) {
	if (!element && !Number.isFinite(event?.clientY)) return undefined;
	const bounds = element?.closest?.('.message')?.getBoundingClientRect();
	const controlBounds = element?.getBoundingClientRect?.();
	const width = 400;
	const left = bounds ? (bounds.left >= width + 10 ? bounds.left - width - 10 : bounds.right + 10) : window.innerWidth - 710;
	const y = event?.clientY || (controlBounds ? controlBounds.top + controlBounds.height / 2 : bounds?.top);
	return {
		width,
		left: Math.max(0, Math.min(left, window.innerWidth - width)),
		...(Number.isFinite(y) ? { top: Math.max(0, Math.min(y - 80, window.innerHeight - 80)) } : {}),
	};
}

async function promptTargetSelection(targets, multiple, title = 'Select Target', position) {
	const preparedTargets = await prepareTargetSelectionData(targets);
	const selectPromise = foundry.applications.api.DialogV2.wait({
		window: { title },
		...(position ? { position } : {}),
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

async function promptPushDistance(distances, position) {
	const gridUnits = canvas.grid?.units || '';
	const distance = await foundry.applications.api.DialogV2.wait({
		window: { title: 'Mastery: Push' },
		...(position ? { position } : {}),
		content: '<p class="wm5e-push-dialog-label">Choose Distance</p>',
		modal: false,
		classes: ['wm5e-push-dialog'],
		buttons: distances.map((distance) => ({ label: `${distance} ${gridUnits}`.trim(), action: String(distance) })),
	});
	return Number(distance) || 0;
}

function createMessageConfig({ activity, target, type = 'damage', rolls, flavor }) {
	const messageConfig = {
		type,
		speaker: ChatMessage.implementation.getSpeaker({ token: activity.getUsageToken() }),
		flavor: flavor || 'a',
		system: { ...activity.messageSources, targets: getTargetDescriptors([target]) },
	};
	if (rolls) messageConfig.rolls = rolls;
	return messageConfig;
}

function getMessageData(message, { targets = message?.system?.targets, targetToken: selectedTarget } = {}) {
	if (!message) return;
	const { speaker, rolls: attackRolls, isAuthor, speakerActor: attacker, author } = message;

	const attackerToken = message.getAssociatedToken?.()?.object ?? canvas.tokens.get(speaker?.token);
	const { actor: target, token: targetToken } = selectedTarget ? { actor: selectedTarget.actor, token: selectedTarget } : dnd5e.dataModels.chatMessage.fields.TargetsField.resolve(targets?.[0]);
	if (!(target instanceof Actor)) return;
	if (!(targetToken?.actor instanceof Actor)) return;
	const activity = message.getAssociatedActivity?.();
	const item = message.getAssociatedItem?.();
	const originatingMessage = message.getOriginatingMessage?.();
	return { message, attacker: message.getAssociatedActor?.() ?? attacker, attackerToken, target, targetToken, activity, item, originatingMessage, attackRolls, isAuthor, author };
}

function getWorkflowTarget(workflow) {
	for (const targets of [workflow?.hitTargets, workflow?.hitTargetsEC, workflow?.targets]) {
		if (targets?.size) return Array.from(targets)[0];
	}
	return null;
}

function getMidiAttackResult(workflow, targetToken) {
	const result = summarizeAttackResult(workflow?.attackRoll);
	if (!result || !workflow.hitDisplayData?.[targetToken?.document?.uuid]) return result;
	const isHit = workflow.hitTargets.has(targetToken) || workflow.hitTargetsEC.has(targetToken);
	return { ...result, isSuccess: isHit, isFailure: !isHit, isHit, isMiss: !isHit };
}

function getTokenFromUuid(uuid) {
	const documentRef = uuid ? fromUuidSync(uuid) : null;
	if (documentRef instanceof TokenDocument) return documentRef.object;
	return null;
}

function getActionContext({ message, shiftKey, requireFailure, requireSuccess, warning, attackResult, attackRoll, targetToken, targets }) {
	const data = getMessageData(message, { targetToken, targets });
	if (!data) return null;

	attackRoll ??= data.attackRolls?.[0];
	if (!attackRoll && !attackResult) return null;

	const { isHit, isMiss } = attackResult ?? summarizeAttackResult(attackRoll);

	if (!shiftKey && ((requireSuccess && isMiss) || (requireFailure && isHit))) {
		ui.notifications.warn(i18n(warning));
		return null;
	}

	return { ...data, attackRoll };
}

async function updateTargetEffect(target, effect, updates) {
	if (target.isOwner) return effect.update(updates);
	return doQueries('updateEffect', { effectUuid: effect.uuid, updates });
}

async function doCleave({ message, shiftKey, el, attackResult, dialogPosition, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireSuccess: true, warning: 'Notifications.CleaveRequiresSuccess', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item, originatingMessage, isAuthor } = context;
	if (!attackerToken || !targetToken || !activity) return false;

	const range = activity.range.reach || gridUnitDistance();

	const inRangeAttacker = ac5e.checkNearby(attackerToken, '!ally', range);
	const inRangeTarget = ac5e.checkNearby(targetToken, 'all', gridUnitDistance());
	const validTargets = inRangeAttacker.filter((t1) => t1.id !== targetToken.id && inRangeTarget.some((t2) => t2.id === t1.id));

	if (!validTargets.length) {
		ui.notifications.warn(i18n('Notifications.CleaveNoTargetsInRange'));
		return false;
	}

	if (validTargets.length === 1) setTargets([validTargets[0].id]);
	const cleaveTarget = await promptTargetSelection(validTargets, 1, 'Select target for Cleave.', dialogPosition);
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
		workflow.targetDescriptors = getTargetDescriptors([cleaveTarget]);
		workflow.wm5e = true;
		cleaveAttackRolls = await activity.rollAttack({ workflow, wm5e: true, wm5eNoMastery: true }, dialogPosition ? { options: { position: dialogPosition } } : {});
		await cleaveAttackRolls?.[0]?.toMessage(createMessageConfig({ activity, target: cleaveTarget, type: 'attack' }));
	} else cleaveAttackRolls = await activity.rollAttack({ wm5e: true, wm5eNoMastery: true }, dialogPosition ? { options: { position: dialogPosition } } : {});
	if (!cleaveAttackRolls?.length) {
		await setTargets([targetToken.id]);
		return false;
	}
	if (cleaveAttackRolls[0].isSuccess) {
		const config = {
			attackMode: 'offhand',
			isCritical: cleaveAttackRolls[0].isCritical,
			wm5eNoMastery: true,
		};
		if (midiActive) {
			workflow.attackMode = 'offhand';
			workflow.isCritical = cleaveAttackRolls[0].isCritical;
			config.workflow = workflow;
			const cleaveDamageRolls = await activity.rollDamage(config, dialogPosition ? { options: { position: dialogPosition } } : {});
			const messageConfig = createMessageConfig({ activity, target: cleaveTarget, type: 'damage', rolls: cleaveDamageRolls });
			await ChatMessage.implementation.create(messageConfig);
		} else await activity.rollDamage(config, dialogPosition ? { options: { position: dialogPosition } } : {});
	}
	await setTargets([targetToken.id]);
	return true;
}

async function doGraze({ message, shiftKey, el, attackResult, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireFailure: true, warning: 'Notifications.GrazeRequiresFailure', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, targetToken, activity, attackRoll } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const abilityId = attackRoll?.options?.ability ?? message.system?.ability ?? activity.ability ?? 'str';
	const ability = attacker?.system?.abilities?.[abilityId];
	if (!ability) return false;
	const mod = ability.mod;
	if (mod <= 0) {
		ui.notifications.warn(i18n('Notifications.GrazeRequiresPositiveModifier'));
		return false;
	}
	const damageType = getActivityDamageType(activity, attackRoll);
	const label = CONFIG.DND5E.weaponMasteries.graze.label;
	const options =
		damageType ?
			{
				type: damageType,
				appearance: { colorset: damageType },
			}
		:	{};
	options.flavor = label;
	const messageConfig = createMessageConfig({ activity, target: targetToken, flavor: `${activity.item.name} - ${label}`, type: 'damage' });
	messageConfig.system.activity = { ...messageConfig.system.activity, name: label };
	return !!(await new CONFIG.Dice.DamageRoll(String(mod), attacker.getRollData(), options).toMessage(messageConfig));
}

async function doNick({ message, shiftKey, el, ...attackContext }) {
	const { attackerToken } = getMessageData(message, attackContext) || {};
	if (!attackerToken) return false;
	const { text: { content } = {} } = await fromUuid(getMasteryReference('nick'));
	const speaker = ChatMessage.implementation.getSpeaker({ token: attackerToken });
	// This only posts the reminder; it does not grant or spend the Light property's extra attack.
	return !!(await ChatMessage.implementation.create({ content, speaker, flavor: 'Mastery Nick' }));
}

async function doPush({ message, shiftKey, el, attackResult, dialogPosition, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireSuccess: true, warning: 'Notifications.PushRequiresSuccess', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, targetToken, target, activity } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const targetTokenSize = Math.max(targetToken.document.width, targetToken.document.height);
	if (targetTokenSize > 2 && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.PushSizeLimit'));
		return false;
	}
	const { angle } = new foundry.canvas.geometry.Ray(attackerToken.center, targetToken.center);
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
	const pushDistance = await promptPushDistance([...positions.keys()], dialogPosition);
	if (!pushDistance) return false;
	const data = { tokenUuid: targetToken.document.uuid, waypoints: positions.get(pushDistance) };
	const pushed = target.isOwner ? await pushAction(data) : await doQueries('push', data);
	if (!pushed) return false;
	return true;
}

function getPushPosition(targetToken, direction, maxDistance) {
	for (const offset of [0, 45, -45]) {
		const point = canvas.grid.getTranslatedPoint(targetToken, direction + offset, maxDistance);
		const snapped = targetToken.getSnappedPosition(point);
		const path = targetToken.findMovementPath([
			{ x: targetToken.x, y: targetToken.y, action: 'wm5ePush' },
			{ ...snapped, snapped: true, action: 'wm5ePush' },
		], { constrainOptions: { ignoreWalls: false, ignoreTokens: false } });
		const destination = path.result?.at(-1);
		if (path.result?.length > 1 && destination.x === snapped.x && destination.y === snapped.y) return path.result.slice(1);
	}
	return null;
}

async function doSap({ message, shiftKey, el, attackResult, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireSuccess: true, warning: 'Notifications.SapRequiresSuccess', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const start = ActiveEffect.implementation.getEffectStart();
	const duration = { expiry: 'sourceStart', value: null, units: 'seconds' };
	const existingEffect = target.appliedEffects.find((ae) => ae.name === effectName('Sap'));
	if (existingEffect) return updateTargetEffect(target, existingEffect, { 'system.origin.item': item.uuid, duration, start });
	const effectData = {
		name: effectName('Sap'),
		img: 'icons/skills/wounds/injury-face-impact-orange.webp',
		disabled: false,
		transfer: false,
		duration,
		start,
		system: {
			origin: { item: item.uuid },
			changes: [{ key: 'flags.automated-conditions-5e.attack.disadvantage', type: 'ac5e', value: 'once;' }],
		},
		flags: {
			wm5e: { source: 'Sap action' },
		},
	};
	const effects = target.isOwner ? await target.createEmbeddedDocuments('ActiveEffect', [effectData]) : await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return !!effects?.length;
}

async function doSlow({ message, shiftKey, el, attackResult, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireSuccess: true, warning: 'Notifications.SlowRequiresSuccess', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const start = ActiveEffect.implementation.getEffectStart();
	const duration = { expiry: 'sourceStart', value: null, units: 'seconds' };
	const existingEffect = target.appliedEffects.find((ae) => ae.name === effectName('SlowWeaponMastery'));
	if (existingEffect) return updateTargetEffect(target, existingEffect, { 'system.origin.item': item.uuid, duration, start });
	const changes = [{ key: 'system.attributes.movement.bonus', type: 'add', value: -2 * gridUnitDistance() }];
	const effectData = {
		name: effectName('SlowWeaponMastery'),
		img: 'icons/magic/movement/chevrons-down-yellow.webp',
		disabled: false,
		transfer: false,
		duration,
		start,
		system: { origin: { item: item.uuid }, changes },
		flags: {
			wm5e: { source: 'Slow action' },
		},
	};
	const effects = target.isOwner ? await target.createEmbeddedDocuments('ActiveEffect', [effectData]) : await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return !!effects?.length;
}

async function doTopple({ message, shiftKey, el, attackResult, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireSuccess: true, warning: 'Notifications.ToppleRequiresSuccess', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	if (target.statuses.has('prone')) {
		ui.notifications.warn(i18n('Notifications.ToppleAlreadyProne'));
		return false;
	}
	const ability = 'con';
	const dc = attacker.system.abilities[activity.ability ?? 'str'].dc;
	const saveRolls = await doQueries('rollSave', { actorUuid: target.uuid, ability, dc, flavor: `${item.name} - Topple Save` });
	if (!saveRolls?.length) return false;
	if (saveRolls[0].total >= dc) return true;
	const effectData = foundry.utils.duplicate(await ActiveEffect.implementation.fromStatusEffect('prone'));
	effectData.system ??= {};
	effectData.system.origin ??= {};
	effectData.system.origin.item = item.uuid;
	effectData.flags = effectData.flags || {};
	effectData.flags.wm5e = { source: 'Topple action' };
	const effects = target.isOwner ? await target.createEmbeddedDocuments('ActiveEffect', [effectData], { keepId: true }) : await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData], options: { keepId: true } });
	return !!effects?.length;
}

function isMatchingVexEffect(effect, attacker, attackerToken) {
	if (effect.name !== effectName('Vex')) return false;
	if (effect.flags?.wm5e?.attackerTokenUuid === attackerToken.document.uuid) return true;
	const originItem = fromUuidSync(effect.system.origin?.item);
	return originItem?.actor?.uuid === attacker.uuid;
}

async function doVex({ message, shiftKey, el, attackResult, ...attackContext }) {
	const context = getActionContext({ ...attackContext, message, shiftKey, requireSuccess: true, warning: 'Notifications.VexRequiresSuccess', attackResult });
	if (!context) return false;
	const { attacker, attackerToken, target, targetToken, activity, item } = context;
	if (!attackerToken || !targetToken || !activity) return false;
	const start = ActiveEffect.implementation.getEffectStart();
	const duration = { expiry: 'sourceEnd', value: null, units: 'seconds' };
	const vexFlags = { source: 'Vex action', attackerUuid: attacker.uuid, attackerTokenUuid: attackerToken.document.uuid, itemUuid: item.uuid };
	const existingEffect = target.appliedEffects.find((ae) => isMatchingVexEffect(ae, attacker, attackerToken));
	if (existingEffect) return updateTargetEffect(target, existingEffect, { 'system.origin.item': item.uuid, duration, start, 'flags.wm5e': vexFlags });
	const effectData = {
		name: effectName('Vex'),
		img: 'icons/magic/symbols/chevron-elipse-circle-blue.webp',
		disabled: false,
		transfer: false,
		duration,
		start,
		system: {
			origin: { item: item.uuid },
			changes: [{ key: 'flags.automated-conditions-5e.grants.attack.advantage', type: 'ac5e', value: 'once; effectOriginTokenId === tokenId && hasAttack' }],
		},
		flags: {
			wm5e: vexFlags,
		},
	};
	const effects = target.isOwner ? await target.createEmbeddedDocuments('ActiveEffect', [effectData]) : await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return !!effects?.length;
}

async function doQueries(type, data) {
	const activeGM = game.users.activeGM;
	if (!activeGM) return false;
	try {
		if (type === 'createEffects') {
			return activeGM.query(Constants.GM_CREATE_EFFECTS, data);
		} else if (type === 'updateEffect') {
			return activeGM.query(Constants.UPDATE_EFFECT, data);
		} else if (type === 'rollSave') {
			const actor = await fromUuid(data.actorUuid);
			const user = getPlayerForActor(actor);
			if (user?.active) return user.query(Constants.ROLL_SAVE, data);
			else return activeGM.query(Constants.ROLL_SAVE, data);
		} else if (type === 'push') {
			return activeGM.query(Constants.PUSH, data);
		} else if (type === 'markMasteryUsed') {
			return await activeGM.query(Constants.MARK_MASTERY_USED, data);
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

async function updateEffect({ effectUuid, updates } = {}) {
	const effect = await fromUuid(effectUuid);
	return effect?.update(updates);
}

async function pushAction({ tokenUuid, waypoints }) {
	const token = await fromUuid(tokenUuid);
	return token?.move(waypoints, { showRuler: true, constrainOptions: { ignoreWalls: false, ignoreTokens: false } });
}

async function rollSavingThrow({ actorUuid, ability, dc, flavor }) {
	const actor = await fromUuid(actorUuid);
	if (!actor) return false;
	return actor?.rollSavingThrow({ ability, target: dc }, {}, { data: { flavor } });
}

function registerQueries() {
	CONFIG.queries[Constants.MODULE_ID] = {};
	CONFIG.queries[Constants.GM_CREATE_EFFECTS] = createEffects;
	CONFIG.queries[Constants.UPDATE_EFFECT] = updateEffect;
	CONFIG.queries[Constants.ROLL_SAVE] = rollSavingThrow;
	CONFIG.queries[Constants.PUSH] = pushAction;
	CONFIG.queries[Constants.MARK_MASTERY_USED] = persistMasteryUsed;
	CONFIG.queries[Constants.CLAIM_MASTERY] = claimMastery;
}

function getTargetDescriptors(tokens) {
	return dnd5e.dataModels.chatMessage.fields.TargetsField.getDescriptors(tokens);
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

class Wm5eWeaponIdsMenu extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: 'wm5e-weapon-ids-menu',
		classes: ['wm5e-weapon-ids-menu'],
		window: {
			title: 'WM5E.WeaponIdsMenu.Title',
			icon: 'fa-solid fa-khanda',
			resizable: true,
		},
		actions: {
			add: Wm5eWeaponIdsMenu.#onAdd,
			remove: Wm5eWeaponIdsMenu.#onRemove,
		},
		position: {
			width: 640,
			height: 'auto',
		},
	};

	static PARTS = {
		body: {
			template: 'modules/wm5e/templates/apps/wm5e-weapon-ids-menu.hbs',
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const weaponIds = game.settings.get(Constants.MODULE_ID, 'weaponIds') ?? {};
		context.weaponIds = Object.entries(weaponIds).map(([baseItem, uuid]) => ({ baseItem, uuid }));
		return context;
	}

	_onRender(context, options) {
		super._onRender(context, options);
		this.element.addEventListener('dragover', Wm5eWeaponIdsMenu.#onDragOver);
		this.element.addEventListener('drop', Wm5eWeaponIdsMenu.#onDrop);
		this.element.addEventListener('change', Wm5eWeaponIdsMenu.#onChange);
	}

	static #onAdd(event) {
		const rows = event.target.closest('.wm5e-weapon-ids-menu')?.querySelector('.wm5e-weapon-ids-rows');
		if (!rows) return;
		Wm5eWeaponIdsMenu.#addRow(rows);
		Wm5eWeaponIdsMenu.#save(event.target.closest('.wm5e-weapon-ids-menu'));
	}

	static #addRow(rows) {
		const row = document.createElement('div');
		row.className = 'wm5e-weapon-ids-row';
		row.innerHTML = `
			<input type="text" name="baseItem" placeholder="${game.i18n.localize('WM5E.WeaponIdsMenu.BaseItemPlaceholder')}" />
			<input type="text" name="uuid" placeholder="${game.i18n.localize('WM5E.WeaponIdsMenu.UuidPlaceholder')}" />
			<button type="button" data-action="remove"><i class="fa-solid fa-trash" inert></i></button>
		`;
		rows.append(row);
		return row;
	}

	static #onRemove(event, target) {
		target.closest('.wm5e-weapon-ids-row')?.remove();
		Wm5eWeaponIdsMenu.#save(event.target.closest('.wm5e-weapon-ids-menu'));
	}

	static #onChange(event) {
		Wm5eWeaponIdsMenu.#save(event.target.closest('.wm5e-weapon-ids-menu'));
	}

	static async #save(app) {
		const weaponIds = {};
		for (const row of app?.querySelectorAll('.wm5e-weapon-ids-row') ?? []) {
			const baseItem = row.querySelector('[name="baseItem"]')?.value?.trim();
			const uuid = row.querySelector('[name="uuid"]')?.value?.trim();
			if (baseItem && uuid) weaponIds[baseItem] = uuid;
		}
		await game.settings.set(Constants.MODULE_ID, 'weaponIds', weaponIds);
	}

	static #onDragOver(event) {
		if (!event.target.closest('.wm5e-weapon-ids-menu')) return;
		event.preventDefault();
	}

	static async #onDrop(event) {
		const app = event.target.closest('.wm5e-weapon-ids-menu');
		if (!app) return;
		const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
		if (!data?.uuid) return;
		event.preventDefault();

		let row = event.target.closest('.wm5e-weapon-ids-row');
		if (!row) row = Wm5eWeaponIdsMenu.#addRow(app.querySelector('.wm5e-weapon-ids-rows'));
		row.querySelector('[name="uuid"]').value = data.uuid;

		const item = await fromUuid(data.uuid);
		if (item?.type === 'weapon' && item.system?.type?.baseItem) row.querySelector('[name="baseItem"]').value ||= item.system.type.baseItem;
		Wm5eWeaponIdsMenu.#save(app);
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

	game.settings.registerMenu(Constants.MODULE_ID, 'weaponIdsMenu', {
		name: 'WM5E.WeaponIdsMenu.Name',
		label: 'WM5E.WeaponIdsMenu.Label',
		hint: 'WM5E.WeaponIdsMenu.Hint',
		icon: 'fa-solid fa-khanda',
		type: Wm5eWeaponIdsMenu,
		restricted: true,
	});

	game.settings.register(Constants.MODULE_ID, 'weaponIds', {
		scope: 'world',
		config: false,
		type: new foundry.data.fields.ObjectField({ initial: {} }),
		onChange: () => applyCustomWeaponIds(),
	});

	game.settings.register(Constants.MODULE_ID, 'autoMasteriesUsers', {
		name: 'WM5E.AutoMasteries.Name',
		hint: 'WM5E.AutoMasteries.Hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.SetField(new foundry.data.fields.StringField({
			choices: () => Object.fromEntries(game.users.map((user) => [user.id, user.name])),
		})),
	});

	// Retain existing user preferences until the GM configures their replacements.
	game.settings.register(Constants.MODULE_ID, 'autoMasteries', {
		name: 'WM5E.AutoMasteries.Name',
		hint: 'WM5E.AutoMasteries.Hint',
		scope: 'user',
		config: false,
		type: new foundry.data.fields.BooleanField({ initial: false }),
	});

	game.settings.register(Constants.MODULE_ID, 'nickReminder', {
		name: 'WM5E.NickReminder.Name',
		hint: 'WM5E.NickReminder.Hint',
		scope: 'user',
		config: true,
		type: new foundry.data.fields.BooleanField({ initial: true }),
	});

	game.settings.register(Constants.MODULE_ID, 'npcMasteries', {
		name: 'WM5E.NpcMasteries.Name',
		hint: 'WM5E.NpcMasteries.Hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField({ initial: false }),
	});
}

function isAutoMasteriesEnabled(userId = game.user.id) {
	const setting = game.settings.storage.get('world').getSetting(`${Constants.MODULE_ID}.autoMasteriesUsers`);
	if (setting) {
		const users = game.settings.get(Constants.MODULE_ID, 'autoMasteriesUsers');
		return users.has(userId);
	}
	return game.settings.storage.get('user').getSetting(`${Constants.MODULE_ID}.autoMasteries`, userId)?.value === true;
}

function isNickReminderEnabled() {
	return game.settings.get(Constants.MODULE_ID, 'nickReminder');
}

function isNpcMasteriesEnabled() {
	return game.settings.get(Constants.MODULE_ID, 'npcMasteries');
}

function applyCustomWeaponIds() {
	for (const baseItem of REGISTERED_WEAPON_IDS) delete CONFIG.DND5E.weaponIds[baseItem];
	REGISTERED_WEAPON_IDS.clear();

	const weaponIds = game.settings.get(Constants.MODULE_ID, 'weaponIds') ?? {};
	for (const [baseItem, uuid] of Object.entries(weaponIds)) {
		if (!baseItem || !uuid) continue;
		CONFIG.DND5E.weaponIds[baseItem] = uuid;
		REGISTERED_WEAPON_IDS.add(baseItem);
	}
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

function masteryRowKey(rowId) {
	return Array.from(rowId, (character) => character.codePointAt(0).toString(16)).join('-');
}

function hasUsedMastery(message, mastery, rowId) {
	if (message.flags?.wm5e?.usedMasteryRows?.[masteryRowKey(rowId)]?.[mastery]) return true;
	// Older releases saved a single boolean on each attack document.
	return !message.flags?.wm5e?.usedMasteryRows && (message.rolls?.length ?? 0) <= 1 && message.flags?.wm5e?.usedMasteries?.[mastery] === true;
}

function canUseMastery(message, user) {
	const actor = message.getAssociatedActor?.() ?? message.speakerActor;
	return user?.isGM || message.canUserModify(user, 'update') || getUsageMessage(message)?.canUserModify(user, 'update') || actor?.testUserPermission(user, 'OWNER');
}

function getMasteryTurn(actor, mastery) {
	if (!['cleave', 'nick'].includes(mastery) || !actor) return null;
	const combat = game.combats?.contents.find((combat) => combat.started && combat.combatants.some((combatant) => combatant.actor?.uuid === actor.uuid)) ?? game.combat;
	return combat?.started && Number.isInteger(combat.turn) ? `${combat.id}:${combat.round}:${combat.turn}` : null;
}

async function executeMastery({ attackMessage, mastery, rowId, el, ...context }) {
	if (!attackMessage || !rowId) return false;
	if (hasUsedMastery(attackMessage, mastery, rowId)) {
		if (el && mastery === 'cleave') ui.notifications.info(i18n('Notifications.CleaveAlreadyUsedAttack'));
		return false;
	}
	const authority = game.users.activeGM ?? (attackMessage.author?.active ? attackMessage.author : null);
	if (!authority) return false;
	const request = (data) => authority.id === game.user.id ? claimMastery(data) : authority.query(Constants.CLAIM_MASTERY, data);
	const data = { messageId: attackMessage.id, mastery, rowId };
	let token, used = false;
	try {
		const claim = await request(data);
		if (claim?.reason === 'usedThisTurn') {
			if (el && mastery === 'cleave') ui.notifications.info(i18n('Notifications.CleaveAlreadyUsedTurn'));
			return false;
		}
		token = claim;
		if (!token) return false;
		used = !!(await WM_ACTIONS[toMasteryLabel(mastery)]({ ...context, el }));
		return used;
	} catch (error) {
		console.error(`${Constants.MODULE_NAME} | Unable to execute mastery:`, error);
		return false;
	} finally {
		if (token) {
			try {
				const saved = await request({ ...data, token, used });
				if (used && saved) markUsed(el);
				else if (used) console.warn(`${Constants.MODULE_NAME} | Unable to save ${mastery} use on ChatMessage ${attackMessage.id}.`);
			} catch (error) {
				console.error(`${Constants.MODULE_NAME} | Unable to finish mastery claim:`, error);
			}
		}
	}
}

function releaseAbandonedMasteryClaims(userId) {
	for (const [key, claim] of MASTERY_CLAIMS) {
		if (claim.complete || (userId ? claim.userId !== userId : game.users.get(claim.userId)?.active !== false)) continue;
		MASTERY_CLAIMS.delete(key);
		if (claim.turnKey && MASTERY_TURN_CLAIMS.get(claim.turnKey) === claim.token) MASTERY_TURN_CLAIMS.delete(claim.turnKey);
	}
}

async function claimMastery({ messageId, mastery, rowId, token, used } = {}, { user = game.user } = {}) {
	if (!Object.hasOwn(WM_ACTIONS, toMasteryLabel(mastery)) || typeof rowId !== 'string' || rowId.length > 256) return false;
	const message = game.messages.get(messageId);
	if (!message?.canUserModify(game.user, 'update') || !canUseMastery(message, user)) return false;
	const authority = game.users.activeGM ?? message.author;
	if (authority?.id !== game.user.id) return false;
	releaseAbandonedMasteryClaims();
	if (message.type === 'attack' && !resolveAttackReference(message, rowId)) return false;
	if (message.type !== 'attack' && (!game.modules.get('midi-qol')?.active || rowId !== `midi:${message.uuid ?? message.id}`)) return false;
	const key = `${messageId}:${masteryRowKey(rowId)}:${mastery}`;
	const existing = MASTERY_CLAIMS.get(key);
	if (token) {
		if (!existing || existing.token !== token || existing.userId !== user.id || existing.complete) return false;
		if (!used) {
			MASTERY_CLAIMS.delete(key);
			if (existing.turnKey) MASTERY_TURN_CLAIMS.delete(existing.turnKey);
			return true;
		}
		// Retain the reservation if persistence fails after the action has already happened.
		existing.complete = true;
		if (existing.turn) {
			const actorKey = existing.actor.uuid;
			const previous = MASTERY_ACTOR_UPDATES.get(actorKey) ?? Promise.resolve();
			const update = previous.catch(() => {}).then(() => {
				const turns = existing.actor.getFlag(Constants.MODULE_ID, `masteryTurns.${mastery}`) ?? [];
				return existing.actor.setFlag(Constants.MODULE_ID, `masteryTurns.${mastery}`, [...new Set([...turns, existing.turn])].slice(-8));
			});
			MASTERY_ACTOR_UPDATES.set(actorKey, update);
			try {
				await update;
			} finally {
				if (MASTERY_ACTOR_UPDATES.get(actorKey) === update) MASTERY_ACTOR_UPDATES.delete(actorKey);
			}
		}
		const saved = await persistMasteryUsed({ messageId, mastery, rowId }, { user });
		if (saved) {
			MASTERY_CLAIMS.delete(key);
			if (existing.turnKey) MASTERY_TURN_CLAIMS.delete(existing.turnKey);
		}
		return saved;
	}
	if (existing || hasUsedMastery(message, mastery, rowId)) return false;
	const actor = message.getAssociatedActor?.() ?? message.speakerActor;
	const turn = getMasteryTurn(actor, mastery);
	const turnKey = turn ? `${actor.uuid}:${mastery}:${turn}` : null;
	if (turnKey && actor.getFlag(Constants.MODULE_ID, `masteryTurns.${mastery}`)?.includes(turn)) return { reason: 'usedThisTurn' };
	if (turnKey && MASTERY_TURN_CLAIMS.has(turnKey)) return false;
	token = foundry.utils.randomID();
	MASTERY_CLAIMS.set(key, { token, userId: user.id, actor, turn, turnKey });
	if (turnKey) MASTERY_TURN_CLAIMS.set(turnKey, token);
	return token;
}

async function markMasteryUsed(message, mastery, el) {
	message = getOriginatingAttackMessage(message?.id) ?? message;
	if (!message || !Object.hasOwn(WM_ACTIONS, toMasteryLabel(mastery))) return false;
	try {
		const data = { messageId: message.id, mastery };
		const saved = message.getFlag(Constants.MODULE_ID, `usedMasteries.${mastery}`) ||
			(message.canUserModify(game.user, 'update') ? await persistMasteryUsed(data) : await doQueries('markMasteryUsed', data));
		if (saved) {
			markUsed(el);
			return true;
		}
		console.warn(`${Constants.MODULE_NAME} | Unable to save ${mastery} use on ChatMessage ${message.id}.`);
	} catch (err) {
		console.error(`${Constants.MODULE_NAME} | Error saving mastery use:`, err);
	}
	return false;
}

async function persistMasteryUsed({ messageId, mastery, rowId } = {}, { user = game.user } = {}) {
	if (!Object.hasOwn(WM_ACTIONS, toMasteryLabel(mastery))) return false;
	const message = rowId?.startsWith('midi:') ? game.messages.get(messageId) : getOriginatingAttackMessage(messageId) ?? game.messages.get(messageId);
	if (!message?.canUserModify(game.user, 'update')) return false;
	if (!canUseMastery(message, user)) return false;
	if (rowId) await message.setFlag(Constants.MODULE_ID, `usedMasteryRows.${masteryRowKey(rowId)}.${mastery}`, true);
	if (!message.getFlag(Constants.MODULE_ID, `usedMasteries.${mastery}`)) await message.setFlag(Constants.MODULE_ID, `usedMasteries.${mastery}`, true);
	return true;
}

function renderUsedMasteries(message, html) {
	for (const el of html.querySelectorAll('a:not(.wm5e-mastery-reference)')) {
		const source = game.messages.get(el.closest('[data-message-id]')?.dataset.messageId) ?? message;
		const rowId = el.closest('[data-bm5e-attack-row-id]')?.dataset.bm5eAttackRowId;
		const reference = resolveAttackReference(source, rowId);
		if (!reference) continue;
		const mastery = Object.keys(WM_ACTIONS).map((key) => key.toLowerCase()).find((key) =>
			(el.dataset.uuid && el.dataset.uuid === getMasteryReference(key)) || el.dataset.tooltip === toMasteryLabel(key));
		if (mastery && hasUsedMastery(reference.message, mastery, reference.rowId)) markUsed(el);
	}
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
