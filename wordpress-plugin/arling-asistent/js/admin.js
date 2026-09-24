/**
 * ARLing Shopping Assistant: "Try it now" buttons on the plugin's settings
 * page. Each example button sends its question to the assistant through the
 * widget's public API (window.ArlingAsistent.ask), the "Open the chat"
 * button only opens it. Loaded on that one settings page only. No network
 * calls of its own, no storage.
 *
 * @package Arling_Asistent
 */
( function () {
	'use strict';

	function ready( fn ) {
		if ( document.readyState !== 'loading' ) {
			fn();
		} else {
			document.addEventListener( 'DOMContentLoaded', fn );
		}
	}

	ready( function () {
		var buttons = document.querySelectorAll( '[data-arling-ask], [data-arling-open]' );
		var note = document.getElementById( 'arling-asistent-preview-note' );

		Array.prototype.forEach.call( buttons, function ( button ) {
			button.addEventListener( 'click', function ( event ) {
				event.preventDefault();
				var widget = window.ArlingAsistent;
				if ( ! widget || typeof widget.open !== 'function' ) {
					if ( note ) {
						note.hidden = false;
					}
					return;
				}
				var question = button.getAttribute( 'data-arling-ask' );
				if ( question ) {
					widget.ask( question );
				} else {
					widget.open();
				}
			} );
		} );
	} );
} )();
