<?php
/**
 * Thin wrapper around the ARLing Shopping Assistant HTTP API, using wp_remote_post()
 * and wp_remote_get() (never curl/file_get_contents directly, so WordPress
 * proxy/SSL/user-agent settings are respected).
 *
 * @package Arling_Asistent
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Arling_Asistent_Api {

	/**
	 * Base URL of the ARLing Shopping Assistant API (no trailing slash), filterable
	 * so a store can be pointed at a different deployment if ARLing ever
	 * moves off the default Cloudflare Workers subdomain.
	 *
	 * @return string
	 */
	public static function base_url() {
		$base = apply_filters( 'arling_asistent_api_base_url', ARLING_ASISTENT_DEFAULT_API_BASE );
		return untrailingslashit( esc_url_raw( $base ) );
	}

	/**
	 * Stripe Payment Link URL for the Starter plan (19 EUR/month), used to
	 * build the "Upgrade" button on the settings page. Empty string means
	 * "not configured yet" (see ARLING_ASISTENT_DEFAULT_STRIPE_LINK_STARTER);
	 * callers must treat that as "show coming soon", never build a URL from it.
	 *
	 * @return string
	 */
	public static function stripe_link_starter() {
		return (string) apply_filters( 'arling_asistent_stripe_link_starter', ARLING_ASISTENT_DEFAULT_STRIPE_LINK_STARTER );
	}

	/**
	 * Same as stripe_link_starter(), for the Pro plan (39 EUR/month).
	 *
	 * @return string
	 */
	public static function stripe_link_pro() {
		return (string) apply_filters( 'arling_asistent_stripe_link_pro', ARLING_ASISTENT_DEFAULT_STRIPE_LINK_PRO );
	}

	/**
	 * Language of ARLing's e-mails to the shop owner, from a WordPress locale:
	 * one of sk, cs, en, de (the four languages the service writes in), any
	 * other locale becomes en. Examples: sk_SK -> sk, cs_CZ -> cs,
	 * de_AT -> de, fr_FR -> en.
	 *
	 * @param string $locale WordPress locale, e.g. "sk_SK".
	 * @return string Two-letter language code.
	 */
	public static function language_from_locale( $locale ) {
		$supported = array( 'sk', 'cs', 'en', 'de' );
		$code      = strtolower( substr( (string) $locale, 0, 2 ) );
		return in_array( $code, $supported, true ) ? $code : 'en';
	}

	/**
	 * Language of the administrator who clicks "Connect" (their own profile
	 * language, not the storefront's), for ARLing's setup e-mails.
	 *
	 * @return string Two-letter language code.
	 */
	public static function email_language() {
		$locale = function_exists( 'get_user_locale' ) ? get_user_locale() : get_locale();
		return self::language_from_locale( $locale );
	}

	/**
	 * POST /v1/tenants { feed_url, domain, email, lang, zdroj } -> { id, domain, status, plan, monthly_quota }
	 *
	 * "lang" is the language of ARLing's e-mails to the shop owner (setup
	 * instructions and at most three service messages), "zdroj" tells the
	 * service the account comes from this plugin, so the e-mail says there is
	 * nothing to paste.
	 *
	 * @param string $feed_url Public WooCommerce Store API product feed URL.
	 * @param string $domain   Site domain (host only, no scheme).
	 * @param string $email    Admin contact e-mail.
	 * @param string $lang     E-mail language (sk, cs, en, de); empty means the service decides.
	 * @return array{ok:bool,data?:array,error?:string,message?:string} Normalised result.
	 */
	public static function create_tenant( $feed_url, $domain, $email, $lang = '' ) {
		$payload = array(
			'feed_url' => $feed_url,
			'domain'   => $domain,
			'email'    => $email,
			'zdroj'    => 'wordpress',
		);
		if ( '' !== (string) $lang ) {
			$payload['lang'] = self::language_from_locale( $lang );
		}
		$response = wp_remote_post(
			self::base_url() . '/v1/tenants',
			array(
				'timeout' => 20,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode( $payload ),
			)
		);

		return self::parse_response( $response, array( 200, 201 ) );
	}

	/**
	 * GET /v1/tenants/:id/status -> { id, domain, status, plan, monthly_quota,
	 * conversations_used, usage_percent, period_start, period_end,
	 * product_count, last_ingest, last_error, used_this_month, last_ingested_at }
	 *
	 * @param string $tenant_id Tenant id returned by create_tenant().
	 * @param int    $timeout   Seconds to wait (shorter for the background check).
	 * @return array{ok:bool,data?:array,error?:string,message?:string} Normalised result.
	 */
	public static function get_status( $tenant_id, $timeout = 15 ) {
		$response = wp_remote_get(
			self::base_url() . '/v1/tenants/' . rawurlencode( $tenant_id ) . '/status',
			array( 'timeout' => (int) $timeout )
		);

		return self::parse_response( $response, array( 200 ) );
	}

	/**
	 * Turn a wp_remote_* result into { ok, data|error, message }, so callers
	 * never need to know about WP_Error vs. HTTP status vs. JSON decoding.
	 *
	 * @param array|WP_Error $response      Result of wp_remote_post()/wp_remote_get().
	 * @param int[]          $expected_codes HTTP status codes considered success.
	 * @return array
	 */
	private static function parse_response( $response, $expected_codes ) {
		if ( is_wp_error( $response ) ) {
			return array(
				'ok'      => false,
				'error'   => 'request_failed',
				'message' => $response->get_error_message(),
			);
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $body ) ) {
			$body = array();
		}

		if ( ! in_array( $code, $expected_codes, true ) ) {
			return array(
				'ok'      => false,
				'error'   => isset( $body['error'] ) ? (string) $body['error'] : 'http_' . $code,
				'message' => isset( $body['issues'] ) && is_array( $body['issues'] ) ? implode( ', ', $body['issues'] ) : '',
				'status'  => $code,
			);
		}

		return array(
			'ok'   => true,
			'data' => $body,
		);
	}
}
