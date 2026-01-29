const Constants = {
	MODULE_ID: 'wm5e',
	MODULE_NAME: 'Weapon Masteries 5e',
	GM_CREATE_EFFECTS: 'wm5e.createEffectsQuery',
	ROLL_SAVE: 'wm5e.rollSaveQuery',
};

let WM_REFERENCES;

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

Hooks.on('init', () => {
	registerQueries();
	registerSettings();
	document.addEventListener('click', onActionsClick, { capture: true });
	document.addEventListener('pointerdown', onActionsClick, { capture: true, passive: false });
	document.addEventListener('contextmenu', onActionsClick, { capture: true, passive: false });
});

Hooks.on('ready', () => (WM_REFERENCES = CONFIG.DND5E.weaponMasteries));
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
	const messageId = attackMessage.id;

	const el = document.querySelector(`[data-message-id="${messageId}"]`)?.querySelector(`a[data-tooltip="${mastery.capitalize()}"]`);
	const parameters = { messageId, shiftKey: false, el };

	if ((action === 'attack' && rollFailure && mastery === 'graze') || (action === 'damage' && rollSuccess && ['cleave', 'sap', 'slow', 'topple', 'vex', 'nick'].includes(mastery))) {
		await WM_ACTIONS[mastery.capitalize()]?.(parameters);
		el.style.textDecoration = 'line-through';
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

	if (!tooltip && !term) return;

	if (event.button === 2) {
		// if the user right clicks, reinstate the original left click open Journal action
		event.preventDefault();
		event.stopImmediatePropagation();

		const JournalEntry = await fromUuid(uuid);
		const target = el.closest('a[data-link]') ?? el;
		const anchor = target?.dataset?.hash ?? null;
		return JournalEntry?.parent?.sheet?.render(true, { pageId: JournalEntry.id, anchor });
	}
	if (event.type !== 'click') return;
	const wmAction = WM_ACTIONS[tooltip] || WM_ACTIONS[term];

	if (!wmAction) return;

	event.preventDefault();
	event.stopPropagation();
	const messageId = el?.closest?.('[data-message-id]')?.dataset?.messageId ?? event?.currentTarget?.dataset?.messageId;
	await wmAction({ messageId, shiftKey, el });
	return;
}

function gridUnitDistance() {
	return canvas?.grid?.distance || 5;
}

function setTargets(targetIds, { mode = 'replace' } = {}) {
	return canvas.tokens.setTargets(targetIds, { mode });
}

async function promptTargetSelection(targets, multiple, title = 'Select Target') {
	for (const t of targets) {
		let img = t.document.texture.src;
		if (foundry.helpers.media.VideoHelper.hasVideoExtension(img)) {
			img = (await game.video?.createThumbnail(img, { width: 50, height: 50 })) ?? '';
		}
		t.wm5e = { img };
	}
	const selectPromise = foundry.applications.api.DialogV2.wait({
		window: { title },
		content: `<p>Choose ${multiple} target(s):</p>`,
		modal: false, //true,  // block other UI interactions?
		buttons: targets.map((t) => ({ label: t.name, img: t.wm5e.img, action: t.id })), //@to-do: rework the icon into the element as this doesn't work
		classes: ['wm5e'],
	});
	setTimeout(() => {
		const dialogEl = document.querySelector('.application.dialog.wm5e');
		if (!dialogEl) return;

		dialogEl.addEventListener('pointerover', (ev) => {
			const btn = ev.target.closest('button');
			if (!btn) return;
			const id = btn.getAttribute('data-action'); // DialogV2 sets button action in data-action
			if (!id) return;
			setTargets([id]);
		});

		dialogEl.addEventListener('pointerout', (ev) => {
			const btn = ev.target.closest('button');
			if (!btn) return;
			setTargets([]);
		});

		const btns = Array.from(dialogEl.querySelectorAll('button')).slice(2); //@to-do: check robustness
		btns.forEach((btn, i) => {
			const t = targets[i];
			if (!t) return;
			btn.classList.add('target-btn', `target-${t.id}`);
			const img = document.createElement('img');
			img.src = t.wm5e.img;
			img.alt = '';
			img.className = 'target-icon'; //maybe for CSS
			img.width = 50;
			img.height = 50;
			img.style.width = '50px';
			img.style.height = '50px';
			img.style.objectFit = 'cover';
			img.style.flex = '0 0 50px';
			btn.prepend(img);
			btn.dataset.targetId = t.id; //is there any need?
		});
	}, 0);
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

function getMessageData(messageId) {
	const message = game.messages.get(messageId);
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

async function doCleave({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls, originatingMessage, isAuthor } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Cleave can only be used on a successful attack roll.');

	const range = activity.range.reach || gridUnitDistance();
	const inRangeAttacker = ac5e.checkNearby(attackerToken, '!ally', range);

	const inRangeTarget = ac5e.checkNearby(targetToken, 'ally', gridUnitDistance());
	const validTargets = inRangeAttacker.filter((t1) => inRangeTarget.some((t2) => t2.id === t1.id));
	if (!validTargets.length) return ui.notifications.warn('No valid targets in range for Cleave.');

	if (validTargets.length === 1) setTargets(validTargets);
	const cleaveTarget = await promptTargetSelection(validTargets, 1, 'Select target for Cleave.');
	if (!cleaveTarget) return ui.notifications.info('no targets');
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
	el.style.textDecoration = 'line-through';
	return setTargets([targetToken.id]);
}

async function doGraze({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, targetToken, activity, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Graze can only be used on a failed attack roll.');
	const damage = attacker.system.abilities[activity.ability].mod;
	if (damage <= 0) return ui.notifications.warn('Graze requires a positive ability modifier to deal damage.');
	const damageType = Object.keys(attackRolls[0].options['automated-conditions-5e'].options.defaultDamageType)[0];
	const options = {
		type: damageType,
		appearance: { colorset: damageType },
	};
	await new CONFIG.Dice.DamageRoll(String(damage), attacker.getRollData(), options).toMessage(createMessageConfig({ activity, target: targetToken }));
	return (el.style.textDecoration = 'line-through');
}

async function doNick({ messageId, shiftKey, el }) {
	const { attackerToken } = getMessageData(messageId) || {};
	const { text: { content } = {} } = await fromUuid(WM_REFERENCES.nick.reference);
	const speaker = ChatMessage.implementation.getSpeaker({ token: attackerToken });
	await ChatMessage.implementation.create({ content, speaker, flavor: 'Mastery Nick' });
	return (el.style.textDecoration = 'line-through');
}

async function doPush({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, targetToken, target, activity, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Push can only be used on a successful attack roll.');
	const targetTokenSize = Math.max(targetToken.document.width, targetToken.document.height);
	if (targetTokenSize > 2 && !shiftKey) return ui.notifications.warn('You can only push large or smaller targets.');
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
			if (testNewPosition.result.length === 1) return ui.notifications.warn('Nowhere to push the target.');
		}
	}
	const finalPosition = testNewPosition.result.at(-1);
	el.style.textDecoration = 'line-through';
	if (target.isOwner) return targetToken.document.update(finalPosition);
	else return doQueries('push', { tokenUuid: targetToken.document.uuid, updates: finalPosition });
}

async function doSap({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Sap can only be used on a successful attack roll.');
	if (target.appliedEffects.some((ae) => ae.name === 'Sap' && ae.origin === item.uuid)) return ui.notifications.warn('Target is already sapped.');
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
	return (el.style.textDecoration = 'line-through');
}

async function doSlow({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Slow can only be used on a successful attack roll.');
	if (target.appliedEffects.some((ae) => ae.name === 'Slow (Weapon Mastery)')) {
		return ui.notifications.warn('Target is already slowed.');
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
	return (el.style.textDecoration = 'line-through');
}

async function doTopple({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Topple can only be used on a successful attack roll.');
	if (target.statuses.prone) return ui.notifications.warn('Target is already prone.');
	const ability = 'con';
	const dc = attacker.system.abilities[activity.ability].dc;
	if (target.isOwner) {
		const [saveResult] = await target.rollSavingThrow({ ability, target: dc }, {}, { data: { flavor: `${item.name} - Topple Save` } });
		if (saveResult?.total < dc) {
			const effectData = foundry.utils.duplicate(await ActiveEffect.implementation.fromStatusEffect('prone'));
			effectData.origin = item.uuid;
			effectData.flags = effectData.flags || {};
			effectData.flags.wm5e = { source: 'Topple action' };
			await target.createEmbeddedDocuments('ActiveEffect', [effectData], { keepId: true });
		}
	} else {
		const [saveResult] = await doQueries('rollSave', { actorUuid: target.uuid, ability, dc, flavor: `${item.name} - Topple Save` });
		if (saveResult?.total < dc) {
			const effectData = foundry.utils.duplicate(await ActiveEffect.implementation.fromStatusEffect('prone'));
			effectData.origin = item.uuid;
			effectData.flags = effectData.flags || {};
			effectData.flags.wm5e = { source: 'Topple action' };
			await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData], options: { keepId: true } });
		}
	}
	return (el.style.textDecoration = 'line-through');
}

async function doVex({ messageId, shiftKey, el }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Vex can only be used on a successful attack roll.');
	if (target.appliedEffects.some((ae) => ae.origin === item.uuid && ae.name === 'Vex')) return ui.notifications.warn('Target is already affected by your Vex.');
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
	return (el.style.textDecoration = 'line-through');
}

async function doQueries(type, data) {
	const activeGM = game.users.activeGM;
	if (!activeGM) return false;
	try {
		if (type === 'createEffects') {
			await activeGM.query(Constants.GM_CREATE_EFFECTS, data);
		} else if (type === 'rollSave') {
			await activeGM.query(Constants.ROLL_SAVE, data);
		} else if (type === 'push') {
			await activeGM.query(Constants.PUSH, data);
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
	return actor?.rollAbilitySave({ ability, target: dc }, {}, { data: { flavor } });
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
