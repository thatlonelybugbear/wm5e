## 13.5250.3.1
* Added Polish localization (pl.json). (contributed by @delgar89)

## 13.5250.3
* Localization keys for effect names.

## 13.5250.2.1
* Actually fix Topple mastery...

## 13.5250.2
* Improved save query routing so saving throws are requested from the relevant active player when possible, with active GM fallback.
* Topple mastery fix.
* Improved weapon mastery chat interactions for players.
  * Non-owners of a chat message can now open and close linked Journal entries on left click (extends default system behavior with close support).
  * Masteries are now visually marked as used in chat with strikethrough plus `(used)`.
* Added module CSS (`styles.css`) for mastery used-state styling and related UI cleanup.
* Added localization support for mastery notification messages via `WM5E.Notifications.*`.

## 13.5250.1.2
* Fix for PUSH query not being registered

## 13.5250.1.1
* Change the automatic masteries setting to be per user.

## 13.5250.1
* Verified compatibility with D&D5e v5.2.5
* Added setting to automatically trigger relevant masteries
* Fixed an issue where Cleave could be retriggered after a Cleave attack.

## 13.5220.4
* Fix for Cleave when MidiQOL is active

## 13.5220.3
* Strike through the mastery link in the chat message when it is used
* The Nick mastery now generates a chat message with its description when used

## 13.5220.2
* Cleave damage roll rework
  * MidiQOL needs another fix

## 13.5220.1
* For 5.2.x, start using `attributes.system.movement.bonus` instead of adding to available movements individually
* Fix for translations which affect `data-tooltip` alongside the textContent
* Fix for damage types for Cleave and Graze not being correctly identified
* Fix for targeting when using Cleave
* Fix for proper ability modifier being used for Cleave, Graze and damage following RAW
* Fixes for MidiQOL compatibility

## 13.5200.1
* System 5.2.0 compatibility bump

## 13.5110.14
* Respect grid distance units for Slow mastery

## 13.5110.13
* Fix for targeting source instead of targeted token when attacking linked actors

## 13.5110.12
* Changed the module name to Automated Masteries 5e (I blame @alterNERDtive for that!)

## 13.5110.11
* Show token image in target selection buttons for Cleave.

## 13.5110.10
* Initial public release
* `Push` automation
* Defensively call canvas.grid
* Consolidate init hook calls
* Fix for Topple not setting target dc to save roll properly
* Fix for `turn` instead of `turns` in effects' data

## 13.5110.2
* Right mouse clicks on the weapon mastery link in the chat messages will now open the Journal entry, like the original left click did.
* SHIFT clicking on the weapon mastery will bypass rules like: "Needs a successful attack to use".
* When you hover over the Cleave dialog's buttons, the corresponding target will be selected. Makes easier to identify targets.
* Several bugfixes.

## 13.5110.1
* Initial release.
* Automated Conditions 5e is a requirement
* Automation for `Cleave`, `Graze`, `Sap`, `Slow`, `Topple`, `Vex`
* To add `Push`
* No automation for `Nick`
* No checks for MidiQOL integration yet.
