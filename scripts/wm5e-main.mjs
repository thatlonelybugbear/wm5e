const Constants = {
	MODULE_ID: 'wm5e',
	MODULE_NAME: 'Weapon Masteries 5e',
	GM_CREATE_EFFECTS: 'wm5e.createEffectsQuery',
	ROLL_SAVE: 'wm5e.rollSaveQuery',
};

const WM_ACTIONS = {
	Cleave: async ({ messageId, shiftKey }) => doCleave({ messageId, shiftKey }),
	Graze: async ({ messageId, shiftKey }) => doGraze({ messageId, shiftKey }),
	Nick: async ({ messageId, shiftKey }) => doNick({ messageId, shiftKey }),
	Push: async ({ messageId, shiftKey }) => doPush({ messageId, shiftKey }),
	Sap: async ({ messageId, shiftKey }) => doSap({ messageId, shiftKey }),
	Slow: async ({ messageId, shiftKey }) => doSlow({ messageId, shiftKey }),
	Topple: async ({ messageId, shiftKey }) => doTopple({ messageId, shiftKey }),
	Vex: async ({ messageId, shiftKey }) => doVex({ messageId, shiftKey }),
};

Hooks.on('init', () => {
	document.addEventListener('click', onActionsClick, { capture: true });
	document.addEventListener('pointerdown', onActionsClick, { capture: true, passive: false });
	document.addEventListener('contextmenu', onActionsClick, { capture: true, passive: false });
});

async function onActionsClick(event) {
	const shiftKey = event.shiftKey;
	let el = event.target;

	if (el.tagName !== 'A') {
		el = el.closest('a');
		if (!el) return;
	}
	const tooltip = el.dataset?.tooltip;
	const uuid = el.dataset?.uuid;
	const term = Object.keys(WM_ACTIONS).find((key) => uuid?.includes(key.toLowerCase()));

	if (!tooltip && !term) return;

	if (event.button === 2) {
		// if right click reinstate the original left click open Journal action
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
	await wmAction({ messageId, shiftKey });
	return;
}

function gridUnitDistance() {
	return canvas.grid.distance;
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
		modal: true,
		buttons: targets.map((t) => ({ label: t.name, icon: t.wm5e.img, action: t.id })),
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
	}, 0);
	const select = await selectPromise;
	if (!select) return false;
	setTargets([select]);
	return true;
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
	const targetToken = target?.token?.object || canvas.tokens.get(ChatMessage.getSpeaker({ actor: attacker })?.token);
	const activity = fromUuidSync(activityUuid);
	const item = fromUuidSync(itemUuid);
	return { message, attacker, attackerToken, target, targetToken, activity, item, originatingMessage, attackRolls, roll, isAuthor, author };
}

async function doCleave({ messageId, shiftKey }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls, originatingMessage, isAuthor } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Cleave can only be used on a successful attack roll.');

	const range = activity.range.reach || gridUnitDistance();
	const inRangeAttacker = ac5e.checkNearby(attackerToken, '!ally', range);

	const inRangeTarget = ac5e.checkNearby(targetToken, 'ally', gridUnitDistance());
	const validTargets = inRangeAttacker.filter((t1) => inRangeTarget.some((t2) => t2.id === t1.id));
	if (!validTargets.length) return ui.notifications.warn('No valid targets in range for Cleave.');

	if (validTargets.length === 1) setTargets(validTargets);
	const shouldProceed = await promptTargetSelection(validTargets, 1, 'Select target for Cleave.');
	if (!shouldProceed) return;

	if (attacker.system.abilities[activity.ability].mod > 0) {
		const damage = foundry.utils.duplicate(activity.damage);
		damage.includeBase = false;
		const clonedActivity = activity.clone({ damage }, { keepId: true });
		if (game.modules.get('midi-qol')?.active) return MidiQOL.completeActivityUse(clonedActivity);
		else {
			const [attackRoll] = await clonedActivity.rollAttack();
			if (attackRoll?.isSuccess) await clonedActivity.rollDamage();
		}
	} else activity.use();
	return;
}

async function doGraze({ messageId, shiftKey }) {
	const { attacker, attackerToken, targetToken, activity, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Graze can only be used on a failed attack roll.');
	const damage = attacker.system.abilities[activity.ability].mod;
	if (damage <= 0) return ui.notifications.warn('Graze requires a positive ability modifier to deal damage.');
	const clonedActivity = activity.clone({ damage: { includeBase: false, parts: [{ custom: { enabled: true, formula: `${damage}` } }] } }, { keepId: true });
	await clonedActivity.rollDamage();
	return;
}

async function doNick() {
	return console.log('Nick action: nothing to implement.');
}

async function doPush() {
	const { attacker, attackerToken, targetToken, activity, attackRolls, author } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Push can only be used on a successful attack roll.');
	const targetTokenSize = Math.max(targetToken.document.width, targetToken.document.height);
	if (targetTokenSize > 2) return ui.notifications.warn('Cannot push targets larger than size 2.');
	return ui.notifications.warn('Push action: movement implementation not yet done.');
}

async function doSap({ messageId, shiftKey }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Sap can only be used on a successful attack roll.');
	if (target.appliedEffects.some((ae) => ae.name === 'Sap' && ae.origin === item.uuid)) return ui.notifications.warn('Target is already sapped.');
	const effectData = {
		name: 'Sap',
		icon: 'icons/skills/wounds/injury-face-impact-orange.webp',
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
}

async function doSlow({ messageId, shiftKey }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Slow can only be used on a successful attack roll.');
	if (target.appliedEffects.some((ae) => ae.name === 'Slow (Weapon Mastery)')) {
		return ui.notifications.warn('Target is already slowed.');
	}
	const movementTypes = Object.entries(target.system.attributes.movement).filter(([key, value]) => key !== 'hover' && value > 0);
	const changes = movementTypes.map(([key, value]) => ({ key: `system.attributes.movement.${key}`, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: -10 }));
	const effectData = {
		name: 'Slow (Weapon Mastery)',
		icon: 'icons/magic/movement/chevrons-down-yellow.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { rounds: 1, turn: 1, startTurn: game.combat?.turn ?? '', startRound: game.combat?.round ?? '', startTime: game.time.worldTime },
		changes,
		flags: {
			wm5e: { source: 'Slow action' },
		},
	};
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
}

async function doTopple({ messageId, shiftKey }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Topple can only be used on a successful attack roll.');
	if (target.statuses.prone) return ui.notifications.warn('Target is already prone.');
	const ability = 'con';
	const dc = attacker.system.abilities[activity.ability].dc;
	if (target.isOwner) {
		const [saveResult] = await target.rollSavingThrow({ ability, dc }, {}, { data: { flavor: `${item.name} - Topple Save` } });
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
}

async function doVex({ messageId, shiftKey }) {
	const { attacker, attackerToken, target, targetToken, activity, item, attackRolls } = getMessageData(messageId) || {};
	if (!attackerToken || !targetToken || !activity) return;
	if (!attackRolls[0].isSuccess && !shiftKey) return ui.notifications.warn('Vex can only be used on a successful attack roll.');
	if (target.appliedEffects.some((ae) => ae.origin === item.uuid && ae.name === 'Vex')) return ui.notifications.warn('Target is already affected by your Vex.');
	const effectData = {
		name: 'Vex',
		icon: 'icons/magic/symbols/chevron-elipse-circle-blue.webp',
		origin: item.uuid,
		disabled: false,
		transfer: false,
		duration: { rounds: 1, turn: 1, startTurn: game.combat?.turn ?? '', startRound: game.combat?.round ?? '', startTime: game.time.worldTime },
		changes: [{ key: 'flags.automated-conditions-5e.grants.attack.advantage', mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: 'once; effectOriginTokenId === tokenId && hasAttack' }],
		flags: {
			wm5e: { source: 'Vex action' },
		},
	};
	if (target.isOwner) await target.createEmbeddedDocuments('ActiveEffect', [effectData]);
	else await doQueries('createEffects', { actorUuid: target.uuid, effects: [effectData] });
}

Hooks.on('init', () => {
	registerSettings();
	registerQueries();
});

async function doQueries(type, { actorUuid, effects, options = {} }) {
	const activeGM = game.users.activeGM;
	if (!activeGM) return false;
	try {
		if (type === 'createEffects') {
			await activeGM.query(Constants.GM_CREATE_EFFECTS, { actorUuid, effects, options });
		} else if (type === 'rollSave') {
			await activeGM.query(Constants.ROLL_SAVE, { actorUuid, ability, options });
		}
		return true;
	} catch (err) {
		console.error(`${Constants.MODULE_NAME} | Error creating effects via GM query:`, err);
		return false;
	}
}

async function createEffects({ actorUuid, effects, options } = {}) {
	const actor = await fromUuid(actorUuid);
	return actor?.createEmbeddedDocuments('ActiveEffect', effects, options);
}

async function rollSavingThrow({ actorUuid, ability, dc, flavor }) {
	const actor = await fromUuid(actorUuid);
	if (!actor) return false;
	return actor.rollAbilitySave({ ability, dc }, {}, { data: { flavor } });
}

function registerQueries() {
	CONFIG.queries[Constants.MODULE_ID] = {};
	CONFIG.queries[Constants.GM_CREATE_EFFECTS] = createEffects;
	CONFIG.queries[Constants.ROLL_SAVE] = rollSavingThrow;
}

function registerSettings() {}
