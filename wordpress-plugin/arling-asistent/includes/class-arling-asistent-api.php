<?php
/**
 * Thin wrapper around the ARLing Asistent HTTP API, using wp_remote_post()
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
	 * Base URL of the ARLing Asistent API (no trailing slash), filterable
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
	 * POST /v1/tenants { feed_url, domain, email } -> { id, domain, status, plan, monthly_quota }
	 *
	 * @param string $feed_url Public WooCommerce Store API product feed URL.
	 * @param string $domain   Site domain (host only, no scheme).
	 * @param string $email    Admin contact e-mail.
	 * @return array{ok:bool,data?:array,error?:string,message?:string} Normalised result.
	 */
	public static function create_tenant( $feed_url, $domain, $email ) {
		$response = wp_remote_post(
			self::base_url() . '/v1/tenants',
			array(
				'timeout' => 20,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode(
					array(
						'feed_url' => $feed_url,
						'domain'   => $domain,
						'email'    => $email,
					)
				),
			)
		);

		return self::parse_response( $response, array( 200, 201 ) );
	}

	/**
	 * GET /v1/tenants/:id/status -> { id, domain, status, plan, monthly_quota, used_this_month, last_ingested_at }
	 *
	 * @param string $tenant_id Tenant id returned by create_tenant().
	 * @return array{ok:bool,data?:array,error?:string,message?:string} Normalised result.
	 */
	public static function get_status( $tenant_id ) {
		$response = wp_remote_get(
			self::base_url() . '/v1/tenants/' . rawurlencode( $tenant_id ) . '/status',
			array( 'timeout' => 15 )
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
