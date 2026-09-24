=== ARLing Shopping Assistant for WooCommerce ===
Contributors: arlingsk
Tags: ai chatbot, chatbot, woocommerce chatbot, product search, shopping assistant
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.3.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

AI chatbot for WooCommerce: answers shoppers from your own product catalogue. Live in about a minute, no account or API key. 100 free chats a month.

== Description ==

Add an AI chatbot to your WooCommerce store that answers shoppers' questions from your own product catalogue and links the matching products. You switch it on inside WordPress in about a minute: no account on another website, no API key, no credit card, and 100 conversations a month are free.

Shoppers ask in their own words ("do you have a waterproof jacket under 80 euros?") and the assistant answers only from your products, with up to three matching products, their price and a link. You can talk to it on the settings page as soon as it is ready, before any shopper sees it.

**What happens after you activate it**

1. The setup screen opens. Your contact e-mail is filled in; you read what will be sent, tick the consent box and click Connect.
2. The assistant reads your public product list (the WooCommerce Store API your shop already serves). For a few hundred products this usually takes under a minute, and the page updates by itself.
3. When it is ready, the chat opens right on the settings page with example questions built from your own categories and products, and the chat bubble appears on your shop.

If something stops it from reading your products (a firewall, password protection, a coming soon page, a switched off REST API, a shop with no products), the settings page says what it was and how to fix it, and has a Try again button. Shoppers do not see the bubble until it works.

**What it does**

* Adds a chat bubble to your storefront that answers shopping questions from your product catalogue.
* Shows up to three matching products, with price and a link, next to each answer.
* Answers in Slovak, Czech, English and German. On a site in another language it answers each shopper in the language they write in.
* Reads your products again automatically once a day.
* Optional gift finder: a second button in the chat asks three questions (for whom, what budget, what interests) and suggests up to five gifts from your own catalogue, each with one short reason. Off until you switch it on.
* Does not store conversation content: only anonymous daily counters (number of conversations, number of product clicks) are kept, to enforce the monthly limit.
* Nothing loads on your storefront until you explicitly connect your store from the settings page.

**What it does not do**

* It does not add products to the cart, place orders, apply coupons or look up orders. It answers and links to the product page.
* It is not a live chat with a person.
* It cannot work on a local or staging copy that is not reachable from the internet (for example localhost, *.local, *.test or WordPress Playground), because the service reads your product list over the internet. The setup screen tells you before you connect.

**Pricing**

* Free: 100 conversations a month, no card, no time limit.
* Starter: 19 EUR a month for up to 1,000 conversations.
* Pro: 39 EUR a month for up to 3,000 conversations.

A conversation is one shopper's chat in one browser tab within 24 hours, however many questions it has. The settings page shows how many you have used, and WordPress warns you at 80 % and 100 %. When the limit is reached, the chat tells new shoppers the assistant is resting and points them to your contact page, until the count starts again on the first day of the month or you move to a larger plan. The free plan never charges anything. Paid plans are paid through Stripe and renew monthly until you cancel them.

Setup guide and live demo: https://arling.sk/asistent/woocommerce/en/

= External services =

This plugin relies on the ARLing Shopping Assistant service to work. Provider: ARLing s. r. o., Bratislava, Slovakia (https://arling.sk). API and widget address: https://arling-asistent.arling.workers.dev (hosted on Cloudflare Workers).

**When you click "Connect" on the settings page** (only after ticking the consent checkbox), and again only if you click "Try again" after a failed setup, this plugin sends to the ARLing Shopping Assistant API:

* Your store's public WooCommerce Store API product list URL (for example `https://your-site/wp-json/wc/store/v1/products?per_page=100`, or the `?rest_route=` form on sites with plain permalinks), which is data your store already serves publicly to any visitor's browser.
* Your site's domain name.
* The contact e-mail address you enter on that screen.

No customer data and no order data is ever sent. Nothing is sent before you connect.

**While connected:**

* The plugin asks the service for your assistant's status (`GET /v1/tenants/{id}/status`: whether it is ready, why a setup failed, plan and conversations used this month) when you open the settings page, and through WP-Cron at most twice a day, so it can warn you before the free limit runs out. The request carries only your assistant's id. Deactivating the plugin stops the twice-daily check.
* The widget script is loaded from ARLing's servers (`https://arling-asistent.arling.workers.dev/widget.js`, or a self-hosted URL if you use the `arling_asistent_widget_endpoint` filter) on the storefront pages you choose, and on the plugin's own settings page for the "Try it now" preview.
* When a shopper (or you, in the preview) uses the chat, the question and the answer are sent to and processed by this same service to generate a reply; the service does not store that conversation content, only daily aggregate counters used to enforce your plan's monthly limit.

**Upgrading**: the upgrade buttons on the settings page link to Stripe Checkout (a payment page hosted by Stripe, https://stripe.com), with your assistant's id attached so your plan updates automatically after a successful payment. The "Manage or cancel your subscription" link opens the Stripe customer portal. No payment details ever pass through this plugin or through ARLing's own servers.

Use of this service is subject to ARLing's:

* Terms of Service: https://arling.sk/podmienky/
* Privacy Policy: https://arling.sk/gdpr/ and https://arling.sk/privacy/
* Data Processing Agreement (GDPR Art. 28): https://arling.sk/asistent/#gdpr

You can disconnect at any time from the settings page, which immediately stops the widget from loading on your site. Disconnecting does not automatically delete data already held by ARLing; contact andrej@arling.sk or use the Data Processing Agreement contact to request deletion.

== Installation ==

1. In wp-admin go to Plugins > Add New Plugin, search for "ARLing Shopping Assistant", click Install Now, then Activate. WooCommerce must already be active, and your shop must be reachable from the internet.
2. The setup screen (WooCommerce > ARLing Shopping Assistant) opens by itself. Check the contact e-mail, read what will be sent, tick the consent checkbox and click **Connect and build my assistant**.
3. Wait until the page says "Your assistant is ready" (usually under a minute; the page refreshes itself).
4. Ask it a question right there, or click one of the example questions. Then open your shop: the chat bubble is in the bottom corner of every page.
5. Optional: choose where the bubble appears, its language, colour mode and corner, and whether to show the gift finder, then click **Save settings**.

== Frequently Asked Questions ==

= Do I need an account on another website or an API key? =

No. Everything happens on the plugin's settings page inside WordPress. You enter a contact e-mail and give consent; there is no password, no API key and no card for the free plan.

= How long until the assistant works on my shop? =

Usually under a minute for a few hundred products, a few minutes for several thousand. The settings page refreshes itself and tells you when it is ready.

= I do not see the chat bubble on my shop. Why? =

Check the settings page first: the bubble only appears once the assistant is ready, and never while the setup has failed. Then check "Show widget on" (all pages, WooCommerce pages only, or nowhere). If you use a caching plugin, clear its cache. An ad blocker in your own browser can also hide it.

= Does it work on a local or staging site? =

Only if that site is reachable from the internet, because the service has to read your product list. Local addresses (localhost, *.local, *.test, private IP addresses) and WordPress Playground cannot be connected; the setup screen says so before anything is sent. You can try the assistant on the demo shop at https://arling.sk/asistent/ instead.

= The settings page says it could not read my products. What now? =

It tells you why. The usual reasons are a security plugin or firewall blocking the public WooCommerce Store API (allow the user agent ARLingAsistentBot), password protection on the whole site, a maintenance or coming soon page, or no published products. Fix it and click Try again.

= What does it cost, and what happens at the limit? =

Free up to 100 conversations a month, no card needed. Above that, 19 EUR a month for up to 1,000 conversations or 39 EUR for up to 3,000, paid through Stripe. You are warned in WordPress at 80 % and 100 %. At the limit, new shoppers are told the assistant is resting until the count starts again on the first day of the month; nothing is charged unless you choose a paid plan.

= What counts as a conversation? =

One shopper's chat in one browser tab within 24 hours, however many questions it contains. A gift finder search in the same tab is the same conversation. Your own test chats on the settings page count too.

= Does this plugin store my customers' conversations? =

No. The ARLing Shopping Assistant service does not keep a record of what was asked or answered. It only keeps daily aggregate counters (how many conversations, how many product-link clicks) per store, used solely to enforce the monthly limit.

= What data leaves my site, and when? =

Nothing leaves your site until you explicitly click "Connect" after ticking the consent checkbox. At that point, your public product list URL, your site domain and the contact e-mail you entered are sent to set up your assistant. See the "External services" section above for everything that is sent while connected.

= Does it slow down my site? =

It adds one deferred script (about 57 KB, about 16 KB compressed) loaded from Cloudflare after the page itself. The chat runs in its own Shadow DOM, so it does not change your theme's styles.

= Which languages does the widget support? =

Slovak, Czech, English and German are built in. You can set one explicitly, or leave it on "Automatic" to follow your site's language. On a site in any other language, Automatic shows the chat buttons in English and the assistant answers each shopper in the language they write in.

= Does it have a gift finder? =

Yes, as an option you switch on. Tick "Gift finder" on the settings page and the chat widget gets a second button next to the chat bubble. It asks who the gift is for, what the budget is and what the person likes, then suggests up to five products from your own catalogue, each with one short reason. It is off by default and adds nothing to your storefront until you turn it on.

= Does this work without WooCommerce? =

No. This plugin reads your store's public WooCommerce Store API product list, so an active WooCommerce installation is required.

= How do I remove the widget or the plugin entirely? =

Click "Disconnect" on the settings page to immediately stop the widget from appearing on your site, without uninstalling the plugin. Deleting the plugin from the Plugins screen also removes all of its local settings from your database (see uninstall.php); it does not, by itself, delete your data on ARLing's servers, see the Data Processing Agreement for how to request that.

== Screenshots ==

1. The setup screen under WooCommerce > ARLing Shopping Assistant: what the free plan includes, the full list of what will be sent, and the consent checkbox that has to be ticked before anything leaves your site.
2. The chat widget answering an English question with two product suggestions, each with a real price, taken from our demo shop's own product feed (the demo shop's catalogue is in Slovak, so product names stay in Slovak).
3. The same widget answering a German question. The interface language follows the Language setting on the plugin's settings screen.
4. The settings page once the assistant is ready: the Try it now section with example questions built from the shop's own catalogue, a button to open the shop, and plan and usage below.

== Changelog ==

= 0.3.0 =
* Activating the plugin now opens the setup screen, and the Plugins screen has a "Set up" link. Before, nothing pointed to the setup screen.
* The setup screen says up front what is free, and warns before you connect when the site cannot work: a local or staging address, WordPress Playground, or a shop with no published products.
* As soon as the assistant is ready, you can try it on the settings page with example questions from your own catalogue, and open your shop from there.
* If your products cannot be read, the settings page now says why (firewall or security plugin, password protection, coming soon page, REST API switched off, no products) and has a Try again button. The chat bubble stays hidden from shoppers until it works.
* Works on sites with "Plain" permalinks: the product list address now comes from WordPress itself instead of a fixed /wp-json/ path.
* New connections show the chat bubble on all pages. It can still be limited to WooCommerce pages.
* Plan and usage with a progress bar, a notice on the Dashboard at 80 % and 100 % of the monthly conversations, and a link to manage a paid plan. Plans are only offered once the assistant works.
* On a site in a language other than Slovak, Czech, English or German, "Automatic" language now answers each shopper in their own language instead of English.
* The settings page shows "Ready" on the next refresh instead of up to 30 seconds late.

= 0.2.1 =
* The Plan section only offers plans that are a step up. A store already on Pro was shown "Upgrade to Starter" and "Upgrade to Pro" at the same time.

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

= 0.3.0 =
Guided setup, a "Try it now" preview, a clear reason and a Try again button when setup fails, and usage warnings. Recommended for every install.

= 0.2.1 =
Small fix to the settings screen. No change on your storefront.

= 0.2.0 =
Adds the optional gift finder. Nothing changes on your storefront until you tick "Gift finder" on the settings page.

= 0.1.2 =
Listing only: screenshots added. No code changes, no need to hurry.

= 0.1.1 =
Fixes the chat on your own domain and defaults to English instead of Slovak for unsupported languages. Recommended for every install.

= 0.1.0 =
Initial release.
