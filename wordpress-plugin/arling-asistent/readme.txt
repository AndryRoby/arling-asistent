=== ARLing Asistent for WooCommerce ===
Contributors: arlingsk
Tags: woocommerce, chatbot, ai assistant, customer support, product search
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

AI shopping assistant chat widget for WooCommerce that answers customer questions from your product feed. No conversations stored.

== Description ==

Plugin page with setup guide and pricing: https://arling.sk/asistent/woocommerce/


ARLing Asistent adds an AI-powered chat widget to your WooCommerce store. Shoppers ask questions in their own words ("do you have a waterproof jacket under 80 euros?") and the assistant answers using only your own product catalogue, with links to the matching products.

Setup takes a few minutes: connect your store from the WooCommerce menu, and ARLing Asistent reads your public WooCommerce Store API product feed to build the assistant's knowledge. No coding, no manual product upload, no theme changes.

**What it does**

* Adds a chat bubble to your storefront that answers shopping questions from your product catalogue.
* Understands Slovak, Czech, English and German.
* Refreshes its product knowledge automatically once a day.
* Shows up to three matching products, with price and a link, alongside each answer.
* Does not store conversation content: only anonymous daily counters (number of conversations, number of product clicks) are kept, to enforce the monthly plan quota.
* Nothing loads on your storefront until you explicitly connect your store from the settings page.

= External services =

This plugin relies on the ARLing Asistent service to work. Provider: ARLing s. r. o., Bratislava, Slovakia (https://arling.sk).

**When you click "Connect" on the settings page** (only after ticking the consent checkbox), this plugin sends to the ARLing Asistent API:

* Your store's public WooCommerce Store API product feed URL (`{your-site}/wp-json/wc/store/v1/products?per_page=100`), which is data your store already serves publicly to any visitor's browser.
* Your site's domain name.
* The contact e-mail address you enter on that screen.

No customer data and no order data is ever sent. Nothing is sent before you connect.

**While connected**, the settings page periodically checks your assistant's setup status by calling the ARLing Asistent API (`GET /v1/tenants/{id}/status`), and the front-end widget script is loaded from ARLing's servers (`https://arling-asistent.arling.workers.dev/widget.js`, or a self-hosted URL if you use the `arling_asistent_widget_endpoint` filter) on the pages you configure. When a shopper uses the chat, their question and the assistant's answer are sent to and processed by this same service to generate a reply; the service does not store that conversation content, only daily aggregate counters used to enforce your plan's monthly quota.

**Upgrading**: the "Upgrade" buttons on the settings page link to Stripe Checkout (a payment page hosted by Stripe, https://stripe.com), with your tenant id attached so your plan updates automatically after a successful payment. No payment details ever pass through this plugin or through ARLing's own servers.

Use of this service is subject to ARLing's:

* Terms of Service: https://arling.sk/podmienky/
* Privacy Policy: https://arling.sk/gdpr/ and https://arling.sk/privacy/
* Data Processing Agreement (GDPR Art. 28): https://arling.sk/asistent/#gdpr

You can disconnect at any time from the settings page, which immediately stops the widget from loading on your site. Disconnecting does not automatically delete data already held by ARLing; contact andrej@arling.sk or use the Data Processing Agreement contact to request deletion.

== Installation ==

1. Upload the plugin to `/wp-content/plugins/arling-asistent`, or install it from the Plugins screen in wp-admin ("Add New Plugin", search for "ARLing Asistent").
2. Activate the plugin through the "Plugins" screen in WordPress. WooCommerce must already be active.
3. Go to **WooCommerce > ARLing Asistent**.
4. Enter a contact e-mail, read what will be sent, tick the consent checkbox, and click **Connect**.
5. Wait for the status to change to "Ready" (usually a few minutes; the page refreshes itself while processing).
6. Choose a language, colour mode, position and where the widget should appear, and click **Save settings**.

== Frequently Asked Questions ==

= Does this plugin store my customers' conversations? =

No. The ARLing Asistent service does not keep a record of what was asked or answered. It only keeps daily aggregate counters (how many conversations, how many product-link clicks) per store, used solely to enforce the monthly plan quota.

= What data leaves my site, and when? =

Nothing leaves your site until you explicitly click "Connect" after ticking the consent checkbox. At that point, your public product feed URL, your site domain, and the contact e-mail you entered are sent once to set up your assistant. See the "External services" section above for full detail.

= Does this work without WooCommerce? =

No. This plugin reads your store's public WooCommerce Store API product feed, so an active WooCommerce installation is required.

= What does it cost? =

Free up to 100 conversations a month, no card needed. Above that, 19 EUR a month up to 1,000 conversations or 39 EUR up to 5,000, paid through Stripe on arling.sk. Nothing is charged automatically: the free tier keeps working within its limit until you choose a paid plan.

= Which languages does the widget support? =

Slovak, Czech, English and German. You can set one explicitly, or leave it on "Automatic" to follow your site's language.

= How do I remove the widget or the plugin entirely? =

Click "Disconnect" on the settings page to immediately stop the widget from appearing on your site, without uninstalling the plugin. Deleting the plugin from the Plugins screen also removes all of its local settings from your database (see uninstall.php); it does not, by itself, delete your tenant data on ARLing's servers, see the Data Processing Agreement for how to request that.

== Screenshots ==

1. The "Connect your store" screen under WooCommerce > ARLing Asistent, showing exactly what data will be sent and the required consent checkbox.
2. The connected status view, showing ingestion status, plan and monthly conversation usage, with a manual refresh option.
3. The chat widget open on a storefront product page, answering a shopping question with linked product suggestions.

== Changelog ==

= 0.1.0 =
* Initial release: connect flow, status polling, language/colour/position/display-scope settings, front-end widget loader.

== Upgrade Notice ==

= 0.1.0 =
Initial release.
