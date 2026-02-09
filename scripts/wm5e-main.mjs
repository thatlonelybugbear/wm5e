const Constants = {
	MODULE_ID: 'wm5e',
	MODULE_NAME: 'Weapon Masteries 5e',
	GM_CREATE_EFFECTS: 'wm5e.createEffectsQuery',
	ROLL_SAVE: 'wm5e.rollSaveQuery',
	PUSH: 'wm5e.pushToken',
};

let WM_REFERENCES;
let LISTENERS_REGISTERED = false;

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

Hooks.on('init', () => {
	registerQueries();
	registerSettings();
});

Hooks.on('ready', () => {
	WM_REFERENCES = CONFIG.DND5E.weaponMasteries;
	if (LISTENERS_REGISTERED) return;
	document.addEventListener('click', onActionsClick, { capture: true });
	document.addEventListener('contextmenu', onActionsClick, { capture: true, passive: false });
	LISTENERS_REGISTERED = true;
});
Hooks.on('dnd5e.preRollAttack', (...args) => doPreRollAttack(args));
Hooks.on('dnd5e.postRollAttack', (...args) => doAutoMasteries(...args, 'attack'));
Hooks.on('dnd5e.rollDamage', (...args) => doAutoMasteries(...args, 'damage'));

function doPreRollAttack(args) {
	const [config, dialog] = args;
	if (config.wm5e) {
		config.mastery = '';
		dialog.options.masteryOptions = [];
	}
}

async function doAutoMasteries() {
	if (!isAutoMasteriesEnabled()) return;
	const [rolls, activity, action] = arguments;
	const originatingMessageId = rolls?.[0]?.parent?.flags?.dnd5e?.originatingMessage;
	const attackMessage = getOriginatingAttackMessage(originatingMessageId);
	if (!attackMessage) return;
	const mastery = attackMessage.flags?.dnd5e?.roll?.mastery;

	const { isCritical, isFailure, isFumble, isSuccess } = attackMessage.rolls?.[0] ?? {};

	if (!mastery) return;
	const rollSuccess = isCritical || isSuccess;
	const rollFailure = isFumble || isFailure;

	const messageEl = document.querySelector(`[data-message-id="${attackMessage.id}"]`);
	const el = findMasteryAnchor(messageEl, mastery);
	const parameters = { message: attackMessage, shiftKey: false, el };

	if ((action === 'attack' && rollFailure && mastery === 'graze') || (action === 'damage' && rollSuccess && ['cleave', 'sap', 'slow', 'topple', 'vex', 'nick'].includes(mastery))) {
		const used = await WM_ACTIONS[toMasteryLabel(mastery)]?.(parameters);
		if (used) markUsed(el);
	}
}

function getOriginatingAttackMessage(messageId) {
	const attackMessage = dnd5e.registry.messages.get(messageId)?.findLast((m) => m.flags.dnd5e?.roll?.type === 'attack');
	return attackMessage;
}

async function onActionsClick(event) {
	let el = event.target;

	if (el.tagName !== 'A') {
		el = el.closest('a');
		if (!el) return;
	}

	const shiftKey = event.shiftKey;
	const tooltip = el.dataset?.tooltip;
	const uuid = el.dataset?.uuid;
	const term = Object.keys(WM_ACTIONS).find((key) => uuid === WM_REFERENCES[key.toLowerCase()].reference);
	const messageId = el?.closest?.('[data-message-id]')?.dataset?.messageId ?? event?.currentTarget?.dataset?.messageId;
	const message = game.messages.get(messageId);

	if (!message?.isOwner || (!tooltip && !term)) return;

	if (event.type === 'contextmenu') {
		// if the user right clicks, reinstate the original left click open Journal action
		event.preventDefault();
		event.stopImmediatePropagation();

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

function gridUnitDistance() {
	return canvas?.grid?.distance || 5;
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

function createMessageConfig({ activity, target, type = 'damage', rolls }) {
	const messageConfig = {};
	messageConfig.speaker = ChatMessage.implementation.getSpeaker({ token: activity.getUsageToken() });
	messageConfig.flavor = 'a';
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
	const {
		flags: { dnd5e: { activity: { uuid: activityUuid }, item: { uuid: itemUuid }, originatingMessage, roll, targets } = {} },
		speaker,
		rolls: attackRolls,
		isAuthor,
		speakerActor: attacker,
		author,
	} = message;

	const attackerToken = canvas.tokens.get(speaker.token);
	const target = fromUuidSync(targets?.[0]?.uuid);
	const targetToken = target?.token?.object || canvas.tokens.get(ChatMessage.getSpeaker({ actor: target })?.token);
	const activity = fromUuidSync(activityUuid);
	const item = fromUuidSync(itemUuid);
	return { message, attacker, attackerToken, target, targetToken, activity, item, originatingMessage, attackRolls, roll, isAuthor, author };
}

async function doCleave({ message, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls, originatingMessage, isAuthor } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (!attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.CleaveRequiresSuccess'));
		return false;
	}

	const range = activity.range.reach || gridUnitDistance();
	const inRangeAttacker = ac5e.checkNearby(attackerToken, '!ally', range);

	const inRangeTarget = ac5e.checkNearby(targetToken, 'ally', gridUnitDistance());
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
	} else cleaveAttackRolls = await activity.rollAttack({ wm5e: true });
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
	const { attacker, attackerToken, targetToken, activity, attackRolls } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.GrazeRequiresFailure'));
		return false;
	}
	const damage = attacker.system.abilities[activity.ability ?? 'str'].mod;
	if (damage <= 0) {
		ui.notifications.warn(i18n('Notifications.GrazeRequiresPositiveModifier'));
		return false;
	}
	const damageType = Object.keys(attackRolls[0].options['automated-conditions-5e'].options.defaultDamageType)[0];
	const options = {
		type: damageType,
		appearance: { colorset: damageType },
	};
	await new CONFIG.Dice.DamageRoll(String(damage), attacker.getRollData(), options).toMessage(createMessageConfig({ activity, target: targetToken }));
	return true;
}

async function doNick({ message, shiftKey, el }) {
	const { attackerToken } = getMessageData(message) || {};
	if (!attackerToken) return false;
	const { text: { content } = {} } = await fromUuid(WM_REFERENCES.nick.reference);
	const speaker = ChatMessage.implementation.getSpeaker({ token: attackerToken });
	await ChatMessage.implementation.create({ content, speaker, flavor: 'Mastery Nick' });
	return true;
}

async function doPush({ message, shiftKey, el }) {
	const { attacker, attackerToken, targetToken, target, activity, attackRolls } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (!attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.PushRequiresSuccess'));
		return false;
	}
	const targetTokenSize = Math.max(targetToken.document.width, targetToken.document.height);
	if (targetTokenSize > 2 && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.PushSizeLimit'));
		return false;
	}
	const maxDistance = 2 * gridUnitDistance();
	const { angle } = new foundry.canvas.geometry.Ray(attackerToken, targetToken);
	const direction = Math.normalizeDegrees(Math.toDegrees(angle));
	let initialNewPosition = canvas.grid.getTranslatedPoint(targetToken, direction, maxDistance);
	let snappedinitialNewPosition = targetToken.getSnappedPosition(initialNewPosition);
	let testNewPosition = targetToken.findMovementPath([{ x: targetToken.x, y: targetToken.y }, snappedinitialNewPosition], {});
	if (testNewPosition.result.length === 1) {
		initialNewPosition = canvas.grid.getTranslatedPoint(targetToken, direction + 45, maxDistance);
		snappedinitialNewPosition = targetToken.getSnappedPosition(initialNewPosition);
		testNewPosition = targetToken.findMovementPath([{ x: targetToken.x, y: targetToken.y }, snappedinitialNewPosition], {});
		if (testNewPosition.result.length === 1) {
			initialNewPosition = canvas.grid.getTranslatedPoint(targetToken, direction - 45, maxDistance);
			snappedinitialNewPosition = targetToken.getSnappedPosition(initialNewPosition);
			testNewPosition = targetToken.findMovementPath([{ x: targetToken.x, y: targetToken.y }, snappedinitialNewPosition], {});
			if (testNewPosition.result.length === 1) {
				ui.notifications.warn(i18n('Notifications.PushNoSpace'));
				return false;
			}
		}
	}
	const finalPosition = testNewPosition.result.at(-1);
	let pushed;
	if (target.isOwner) pushed = await targetToken.document.update(finalPosition);
	else pushed = await doQueries('push', { tokenUuid: targetToken.document.uuid, updates: finalPosition });
	if (!pushed) return false;
	return true;
}

async function doSap({ message, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (!attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.SapRequiresSuccess'));
		return false;
	}
	if (target.appliedEffects.some((ae) => ae.name === 'Sap' && ae.origin === item.uuid)) {
		ui.notifications.warn(i18n('Notifications.SapAlreadyApplied'));
		return false;
	}
	const effectData = {
		name: 'Sap',
		img: 'icons/skills/wounds/injury-face-impact-orange.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { rounds: 1, turn: 1, startTurn: game.combat?.turn ?? '', startRound: game.combat?.round ?? '', startTime: game.time.worldTime },
		changes: [{ key: 'flags.automated-conditions-5e.attack.disadvantage', mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: 'once;' }],
		flags: {
			wm5e: { source: 'Sap action' },
		},
	};
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return true;
}

async function doSlow({ message, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (!attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.SlowRequiresSuccess'));
		return false;
	}
	if (target.appliedEffects.some((ae) => ae.name === 'Slow (Weapon Mastery)')) {
		ui.notifications.warn(i18n('Notifications.SlowAlreadyApplied'));
		return false;
	}
	const movementTypes = Object.entries(target.system.attributes.movement).filter(([key, value]) => key !== 'hover' && value > 0);
	let changes;
	if (foundry.utils.isNewerVersion(game.system.version, '5.2.0')) changes = [{ key: 'system.attributes.movement.bonus', mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: -2 * gridUnitDistance() }];
	else changes = movementTypes.map(([key, value]) => ({ key: `system.attributes.movement.${key}`, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: -2 * gridUnitDistance() }));
	const effectData = {
		name: 'Slow (Weapon Mastery)',
		img: 'icons/magic/movement/chevrons-down-yellow.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { rounds: 1, turns: 1, startTurn: game.combat?.turn ?? '', startRound: game.combat?.round ?? '', startTime: game.time.worldTime },
		changes,
		flags: {
			wm5e: { source: 'Slow action' },
		},
	};
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
	return true;
}

async function doTopple({ message, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (!attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.ToppleRequiresSuccess'));
		return false;
	}
	if (target.statuses.prone) {
		ui.notifications.warn(i18n('Notifications.ToppleAlreadyProne'));
		return false;
	}
	const ability = 'con';
	const dc = attacker.system.abilities[activity.ability ?? 'str'].dc;
	const saveRoll = await doQueries('rollSave', { actorUuid: target.uuid, ability, dc, flavor: `${item.name} - Topple Save` });
	if (saveRoll?.isSuccess) return true;
	const effectData = foundry.utils.duplicate(await ActiveEffect.implementation.fromStatusEffect('prone'));
	effectData.origin = item.uuid;
	effectData.flags = effectData.flags || {};
	effectData.flags.wm5e = { source: 'Topple action' };
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData], { keepId: true });
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData], options: { keepId: true } });
	return true;
}

async function doVex({ message, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(message) || {};
	if (!attackerToken || !targetToken || !activity) return false;
	if (!attackRolls[0].isSuccess && !shiftKey) {
		ui.notifications.warn(i18n('Notifications.VexRequiresSuccess'));
		return false;
	}
	if (target.appliedEffects.some((ae) => ae.origin === item.uuid && ae.name === 'Vex')) {
		ui.notifications.warn(i18n('Notifications.VexAlreadyApplied'));
		return false;
	}
	const effectData = {
		name: 'Vex',
		img: 'icons/magic/symbols/chevron-elipse-circle-blue.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { rounds: 1, turns: 1, startTurn: game.combat?.turn ?? '', startRound: game.combat?.round ?? '', startTime: game.time.worldTime },
		changes: [{ key: 'flags.automated-conditions-5e.grants.attack.advantage', mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: 'once; effectOriginTokenId === tokenId && hasAttack' }],
		flags: {
			wm5e: { source: 'Vex action' },
		},
	};
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

function registerSettings() {
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
	return WM_REFERENCES?.[masteryKey]?.reference ?? '';
}

function findMasteryAnchor(root, masteryKey) {
	if (!root?.querySelector || !masteryKey) return null;
	const reference = getMasteryReference(masteryKey);
	if (reference) {
		const byUuid = root.querySelector(`a[data-uuid="${reference}"]`);
		if (byUuid) return byUuid;
	}
	const label = toMasteryLabel(masteryKey);
	if (!label) return null;
	return root.querySelector(`a[data-tooltip="${label}"]`);
}
