# Calendar import

`ical.js` is the unmodified ICAL.js 2.2.1 browser distribution (MPL-2.0; see ICAL-LICENSE), from https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz. `import.js` applies size, recurrence, identity and timezone validation around that parser. Both desktop workers and the native iOS JavaScriptCore adapter use the same source. No calendar data is executed as JavaScript or fetched by the parser.

Floating calendar times use the current device timezone. UTC and included VTIMEZONE definitions retain their timezone semantics. Unknown timezone definitions are rejected rather than guessed. Recurrences are expanded only within the explicit import range; importing does not create a feed subscription or send invitations.
