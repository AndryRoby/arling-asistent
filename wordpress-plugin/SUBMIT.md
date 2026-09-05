# Submitting ARLing Asistent for WooCommerce to wordpress.org

Checklist for Andrej. wordpress.org plugin review is manual and volunteer-run, so timing below is typical, not guaranteed.

## 0. Before you start (things to update in the plugin itself)

- [ ] `readme.txt`: `Contributors: arling` is a placeholder. Replace it with your actual wordpress.org username once you have one (see step 1). It must be a real, existing wordpress.org.org account username, not a display name.
- [ ] `readme.txt`: `Tested up to: 6.9` should be bumped to whatever the current WordPress release is at the time you actually submit.
- [ ] Confirm the worker is deployed and `https://arling-asistent.arling.workers.dev` (or whatever domain you end up using) is live and answering `/v1/tenants`, `/v1/tenants/:id/status` and `/widget.js` with working CORS, since the review team, and then real users, will click "Connect" for real.
- [ ] Take three real screenshots from an actual WordPress admin with the plugin installed (see "Screenshots" below); the readme.txt Screenshots section currently only has text descriptions.
- [ ] Decide the real pricing wording before you submit if it might change: readme.txt currently says "Free during the beta, for up to 100 conversations a month. After the beta, plans start at 19 EUR/month."

## 1. Create a wordpress.org account (if you do not have one)

1. Go to https://login.wordpress.org/register and create an account. This is the same account system as WordPress.org profiles, forums and Slack.
2. Log in once at https://wordpress.org/plugins/developers/add/ so the account exists in the plugin submission system.

## 2. Submit the plugin for review

1. Go to https://wordpress.org/plugins/developers/add/.
2. Upload a zip of the **plugin source**, not a built/compiled zip: the reviewers want to read the actual PHP. Use `wordpress-plugin/arling-asistent-0.1.0.zip` from this repository (contains only the `arling-asistent/` plugin folder: `arling-asistent.php`, `uninstall.php`, `readme.txt`, `includes/`, `languages/`).
3. Fill in the submission form. It mostly reads `readme.txt` automatically; double check the short description shown matches.
4. Submit. You will get an automated confirmation e-mail immediately.

## 3. Review time

- The wordpress.org Plugin Review Team is volunteer-run. Typical first response time is **2 to 4 weeks**, sometimes longer during busy periods. There is no way to pay to expedite it.
- Most first submissions get an e-mail back asking for changes (this is normal, not a rejection): common requests are escaping/sanitization fixes, clarifying the external service disclosure, or trimming permissions. Reply to that e-mail thread with the fixes; you do not resubmit the form.
- Once accepted, you get an e-mail with your assigned SVN repository URL, of the form `https://plugins.svn.wordpress.org/arling-asistent/` (the slug is normally derived from the plugin's folder/zip name; wordpress.org sometimes assigns a competing name if the slug is taken - only likely to happen if someone already registered `arling-asistent`, unlikely but check https://wordpress.org/plugins/arling-asistent/ returns "not found" before submitting).

## 4. First SVN commit (after acceptance)

wordpress.org plugin hosting uses Subversion (SVN), not Git, even though the plugin's own source of truth stays in this repository's normal git history.

```bash
svn checkout https://plugins.svn.wordpress.org/arling-asistent/ arling-asistent-svn
cd arling-asistent-svn
```

You will see three top-level folders: `trunk/`, `tags/`, `assets/`.

1. Copy the plugin's contents into `trunk/`:
   ```bash
   cp -r "/path/to/wordpress-plugin/arling-asistent/." trunk/
   ```
2. Put the three real screenshots (see below) into `assets/` at the SVN root (not inside `trunk/`), named `screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png`. Optionally add `icon-128x128.png` / `icon-256x256.png` and `banner-772x250.png` / `banner-1544x500.png` here too for the plugin page's icon and banner.
3. Add everything and commit:
   ```bash
   svn add trunk/* assets/*
   svn commit -m "Initial release 0.1.0" --username YOUR_WORDPRESS_ORG_USERNAME
   ```
   You will be prompted for your wordpress.org account password (or an SVN-specific password if you set one under your wordpress.org profile's "SVN Password" section).
4. Tag the release so `Stable tag: 0.1.0` in readme.txt resolves to something:
   ```bash
   svn copy trunk tags/0.1.0
   svn commit -m "Tag 0.1.0" --username YOUR_WORDPRESS_ORG_USERNAME
   ```
5. Your plugin page goes live at `https://wordpress.org/plugins/arling-asistent/` within a few minutes to an hour after the trunk commit (readme.txt is reparsed automatically; if the page looks wrong, use the "readme validator" linked from your plugin's SVN admin page).

## 5. Screenshots to prepare (referenced by readme.txt "Screenshots" section)

Take these from a real WooCommerce install with the plugin active:

1. `screenshot-1.png`: WooCommerce > ARLing Asistent, the "Connect your store" screen, showing the data-sent list and consent checkbox.
2. `screenshot-2.png`: The connected status view (status/plan/conversation count table) with the widget settings form below it.
3. `screenshot-3.png`: The chat widget open on a live storefront page, mid-conversation, with a product suggestion card visible.

Recommended size: 1280x800 or 1544x500 for a wide screenshot; wordpress.org displays them scaled down, PNG or JPG.

## 6. After acceptance: updating the plugin later

For every future version:

```bash
cd arling-asistent-svn
svn update
cp -r "/path/to/wordpress-plugin/arling-asistent/." trunk/
svn commit -m "Version X.Y.Z" --username YOUR_WORDPRESS_ORG_USERNAME
svn copy trunk tags/X.Y.Z
svn commit -m "Tag X.Y.Z" --username YOUR_WORDPRESS_ORG_USERNAME
```

Bump both `Version:` in `arling-asistent.php` and `Stable tag:` in `readme.txt` to match X.Y.Z before copying; wordpress.org treats a mismatch between the two as a packaging error and will not show the update to users.

## Reference

- Plugin developer FAQ: https://developer.wordpress.org/plugins/wordpress-org/
- Detailed plugin guidelines: https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/
- readme.txt format validator: https://wordpress.org/plugins/developers/readme-validator/
