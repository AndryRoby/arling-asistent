=== ARLing Shopping Assistant for WooCommerce ===
Contributors: arlingsk
Tags: woocommerce, chatbot, ai assistant, shopping assistant, gift finder
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

AI shopping assistant chat widget for WooCommerce that answers customer questions from your product feed. No conversations stored.

== Description ==

Plugin page with setup guide and pricing: https://arling.sk/asistent/woocommerce/


ARLing Shopping Assistant adds an AI-powered chat widget to your WooCommerce store. Shoppers ask questions in their own words ("do you have a waterproof jacket under 80 euros?") and the assistant answers using only your own product catalogue, with links to the matching products.

Setup takes a few minutes: connect your store from the WooCommerce menu, and ARLing Shopping Assistant reads your public WooCommerce Store API product feed to build the assistant's knowledge. No coding, no manual product upload, no theme changes.

**What it does**

* Adds a chat bubble to your storefront that answers shopping questions from your product catalogue.
* Understands Slovak, Czech, English and German.
* Refreshes its product knowledge automatically once a day.
* Shows up to three matching products, with price and a link, alongside each answer.
* Optional gift finder: a second button in the chat asks three questions (for whom, what budget, what interests) and suggests up to five gifts from your own catalogue, each with one short reason. Off until you switch it on.
* Does not store conversation content: only anonymous daily counters (number of conversations, number of product clicks) are kept, to enforce the monthly plan quota.
* Nothing loads on your storefront until you explicitly connect your store from the settings page.

= External services =

This plugin relies on the ARLing Shopping Assistant service to work. Provider: ARLing s. r. o., Bratislava, Slovakia (https://arling.sk).

**When you click "Connect" on the settings page** (only after ticking the consent checkbox), this plugin sends to the ARLing Shopping Assistant API:

* Your store's public WooCommerce Store API product feed URL (`{your-site}/wp-json/wc/store/v1/products?per_page=100`), which is data your store already serves publicly to any visitor's browser.
* Your site's domain name.
* The contact e-mail address you enter on that screen.

No customer data and no order data is ever sent. Nothing is sent before you connect.

**While connected**, the settings page periodically checks your assistant's setup status by calling the ARLing Shopping Assistant API (`GET /v1/tenants/{id}/status`), and the front-end widget script is loaded from ARLing's servers (`https://arling-asistent.arling.workers.dev/widget.js`, or a self-hosted URL if you use the `arling_asistent_widget_endpoint` filter) on the pages you configure. When a shopper uses the chat, their question and the assistant's answer are sent to and processed by this same service to generate a reply; the service does not store that conversation content, only daily aggregate counters used to enforce your plan's monthly quota.

**Upgrading**: the "Upgrade" buttons on the settings page link to Stripe Checkout (a payment page hosted by Stripe, https://stripe.com), with your tenant id attached so your plan updates automatically after a successful payment. No payment details ever pass through this plugin or through ARLing's own servers.

Use of this service is subject to ARLing's:

* Terms of Service: https://arling.sk/podmienky/
* Privacy Policy: https://arling.sk/gdpr/ and https://arling.sk/privacy/
* Data Processing Agreement (GDPR Art. 28): https://arling.sk/asistent/#gdpr

You can disconnect at any time from the settings page, which immediately stops the widget from loading on your site. Disconnecting does not automatically delete data already held by ARLing; contact andrej@arling.sk or use the Data Processing Agreement contact to request deletion.

== Installation ==

1. Upload the plugin to `/wp-content/plugins/arling-asistent`, or install it from the Plugins screen in wp-admin ("Add New Plugin", search for "ARLing Shopping Assistant").
2. Activate the plugin through the "Plugins" screen in WordPress. WooCommerce must already be active.
3. Go to **WooCommerce > ARLing Shopping Assistant**.
4. Enter a contact e-mail, read what will be sent, tick the consent checkbox, and click **Connect**.
5. Wait for the status to change to "Ready" (usually a few minutes; the page refreshes itself while processing).
6. Choose a language, colour mode, position, where the widget should appear, and whether to show the gift finder button, then click **Save settings**.

== Frequently Asked Questions ==

= Does this plugin store my customers' conversations? =

No. The ARLing Shopping Assistant service does not keep a record of what was asked or answered. It only keeps daily aggregate counters (how many conversations, how many product-link clicks) per store, used solely to enforce the monthly plan quota.

= What data leaves my site, and when? =

Nothing leaves your site until you explicitly click "Connect" after ticking the consent checkbox. At that point, your public product feed URL, your site domain, and the contact e-mail you entered are sent once to set up your assistant. See the "External services" section above for full detail.

= Does this work without WooCommerce? =

No. This plugin reads your store's public WooCommerce Store API product feed, so an active WooCommerce installation is required.

= What does it cost? =

Free up to 100 conversations a month, no card needed. Above that, 19 EUR a month up to 1,000 conversations or 39 EUR up to 3,000, paid through Stripe on arling.sk. Nothing is charged automatically: the free tier keeps working within its limit until you choose a paid plan.

= Which languages does the widget support? =

Slovak, Czech, English and German. You can set one explicitly, or leave it on "Automatic" to follow your site's language.

= Does it have a gift finder? =

Yes, as an option you switch on. Tick "Gift finder" on the settings page and the chat widget gets a second button next to the chat bubble. It asks who the gift is for, what the budget is and what the person likes, then suggests up to five products from your own catalogue, each with one short reason. It is switched off by default and adds nothing at all to your storefront until you turn it on.

= How do I remove the widget or the plugin entirely? =

Click "Disconnect" on the settings page to immediately stop the widget from appearing on your site, without uninstalling the plugin. Deleting the plugin from the Plugins screen also removes all of its local settings from your database (see uninstall.php); it does not, by itself, delete your tenant data on ARLing's servers, see the Data Processing Agreement for how to request that.

== Screenshots ==

1. The "Connect your store" screen under WooCommerce > ARLing Shopping Assistant: the contact e-mail field, the full list of what will be sent, and the consent checkbox that has to be ticked before anything leaves your site.
2. The chat widget answering an English question with two product suggestions, each with a real price, taken from our demo shop's own product feed.
3. The same widget answering a German question. The interface language follows the Language setting on the plugin's settings screen.

== Changelog ==

= 0.2.0 =
* Added an optional gift finder: a "Find a gift" button in the chat asks for whom, what budget and what interests, then suggests up to five products from your catalogue, each with one short reason. Switched off by default, tick "Gift finder" on the settings page to enable it.
* The widget position setting (bottom right or bottom left) now actually takes effect. Earlier versions saved it but the widget ignored it.

= 0.1.2 =
* Added screenshots to the plugin directory listing and corrected the screenshot descriptions to match them.

= 0.1.1 =
* Renamed to ARLing Shopping Assistant: the previous name read as a misspelling of "assistant" in English.
* Chat interface now falls back to English, not Slovak, when the shop's language is not one of the four supported ones.
* Fixed the CORS preflight so the chat works on any shop domain, not only on arling.sk.

= 0.1.0 =
* Initial release: connect flow, status polling, language/colour/position/display-scope settings, front-end widget loader.

== Upgrade Notice ==

= 0.2.0 =
Adds the optional gift finder. Nothing changes on your storefront until you tick "Gift finder" on the settings page.

= 0.1.2 =
Listing only: screenshots added. No code changes, no need to hurry.

= 0.1.1 =
Fixes the chat on your own domain and defaults to English instead of Slovak for unsupported languages. Recommended for every install.

= 0.1.0 =
Initial release.
