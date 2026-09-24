<?php
/**
 * TEST HARNESS ONLY, NEVER ON A REAL SITE, NEVER INSIDE arling-asistent/:
 * it logs any request carrying the X-Arltest-User header in as user 1 and
 * mocks every call to the ARLing worker, so no request ever reaches
 * production. Used by drive.mjs in this folder (see its header for how to
 * run). Mode is switched with ?arltest_set=<mode>: pending, ready<N>
 * (N = conversations used of 100), starter, error[:code], notfound, down,
 * ratelimited.
 */

if ( ! function_exists( 'wp_validate_auth_cookie' ) ) {
	function wp_validate_auth_cookie( $cookie = '', $scheme = '' ) {
		return isset( $_SERVER['HTTP_X_ARLTEST_USER'] ) ? 1 : false;
	}
}
add_filter(
	'determine_current_user',
	function ( $id ) {
		return isset( $_SERVER['HTTP_X_ARLTEST_USER'] ) ? 1 : $id;
	},
	99
);

// Site language override (core refuses WPLANG values with no language pack installed).
add_filter(
	'locale',
	function ( $locale ) {
		$forced = get_option( 'arltest_locale', '' );
		return $forced ? $forced : $locale;
	}
);

// Local site on 127.0.0.1: skip the reachability check unless we test it.
add_filter(
	'arling_asistent_unreachable_reason',
	function ( $reason, $host ) {
		return 'real' === get_option( 'arltest_reach', '' ) ? $reason : '';
	},
	10,
	2
);

add_action(
	'init',
	function () {
		if ( isset( $_GET['arltest_set'] ) ) {
			update_option( 'arltest_mode', sanitize_text_field( wp_unslash( $_GET['arltest_set'] ) ) );
			global $wpdb;
			$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient%arling_asistent_status_%'" );
			wp_cache_flush();
			echo 'mode set';
			exit;
		}
		if ( isset( $_GET['arltest_reset'] ) ) {
			foreach ( array( 'arling_asistent_tenant_id', 'arling_asistent_domain', 'arling_asistent_email', 'arling_asistent_connected_at', 'arling_asistent_lang', 'arling_asistent_color', 'arling_asistent_position', 'arling_asistent_display_scope', 'arling_asistent_gift', 'arling_asistent_status', 'arltest_calls', 'arltest_reach', 'arltest_locale' ) as $o ) {
				delete_option( $o );
			}
			delete_user_meta( 1, 'arling_asistent_dismissed' );
			wp_clear_scheduled_hook( 'arling_asistent_status_check' );
			echo 'reset';
			exit;
		}
		if ( isset( $_GET['arltest_locale'] ) ) {
			update_option( 'arltest_locale', sanitize_text_field( wp_unslash( $_GET['arltest_locale'] ) ) );
			echo 'locale set';
			exit;
		}
		if ( isset( $_GET['arltest_reach'] ) ) {
			update_option( 'arltest_reach', sanitize_text_field( wp_unslash( $_GET['arltest_reach'] ) ) );
			echo 'reach set';
			exit;
		}
		if ( isset( $_GET['arltest_redirect'] ) ) {
			set_transient( 'arling_asistent_activation_redirect', 1, 60 );
			echo 'redirect set';
			exit;
		}
		if ( isset( $_GET['arltest_cron'] ) ) {
			Arling_Asistent_Admin::cron_status_check();
			echo 'cron ran';
			exit;
		}
		if ( isset( $_GET['arltest_dump'] ) ) {
			header( 'Content-Type: application/json' );
			echo wp_json_encode(
				array(
					'tenant'   => get_option( 'arling_asistent_tenant_id' ),
					'email'    => get_option( 'arling_asistent_email' ),
					'scope'    => get_option( 'arling_asistent_display_scope' ),
					'status'   => get_option( 'arling_asistent_status' ),
					'cron'     => wp_next_scheduled( 'arling_asistent_status_check' ),
					'calls'    => get_option( 'arltest_calls', array() ),
					'dismissed'=> get_user_meta( 1, 'arling_asistent_dismissed', true ),
				)
			);
			exit;
		}
	},
	1
);

add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) {
		if ( false === strpos( $url, 'arling-asistent.arling.workers.dev' ) ) {
			return $pre;
		}
		$calls   = get_option( 'arltest_calls', array() );
		$calls[] = array(
			'method' => isset( $args['method'] ) ? $args['method'] : 'GET',
			'url'    => $url,
			'body'   => isset( $args['body'] ) ? $args['body'] : '',
		);
		update_option( 'arltest_calls', $calls );

		$mode = (string) get_option( 'arltest_mode', 'pending' );
		if ( 'down' === $mode ) {
			return new WP_Error( 'http_request_failed', 'cURL error 28: Connection timed out' );
		}

		$code = 200;
		if ( false !== strpos( $url, '/v1/tenants' ) && false === strpos( $url, '/status' ) ) {
			if ( 'ratelimited' === $mode ) {
				$code = 429;
				$body = array( 'error' => 'rate_limited' );
			} else {
				$code = 201;
				$body = array( 'id' => 't-test-1', 'domain' => '127.0.0.1', 'status' => 'pending', 'plan' => 'free', 'monthly_quota' => 100 );
			}
		} elseif ( 'notfound' === $mode ) {
			$code = 404;
			$body = array( 'error' => 'not_found' );
		} else {
			$body = array(
				'id'                 => 't-test-1',
				'domain'             => '127.0.0.1',
				'plan'               => 'free',
				'status'             => 'pending',
				'monthly_quota'      => 100,
				'conversations_used' => 0,
				'usage_percent'      => 0,
				'period_start'       => '2026-09-01',
				'period_end'         => '2026-10-01',
				'product_count'      => 0,
				'valid_until'        => null,
				'last_ingest'        => null,
				'last_error'         => null,
				'used_this_month'    => 0,
				'last_ingested_at'   => null,
			);
			if ( 0 === strpos( $mode, 'ready' ) ) {
				$used                        = (int) substr( $mode, 5 );
				$body['status']              = 'ready';
				$body['product_count']       = 3;
				$body['last_ingest']         = '2026-09-24T18:00:00.000Z';
				$body['conversations_used']  = $used;
				$body['used_this_month']     = $used;
				$body['usage_percent']       = $used;
			} elseif ( 0 === strpos( $mode, 'starter' ) ) {
				$body['status']        = 'ready';
				$body['plan']          = 'starter';
				$body['monthly_quota'] = 1000;
				$body['product_count'] = 3;
			} elseif ( 0 === strpos( $mode, 'error' ) ) {
				$body['status']     = 'error';
				$parts              = explode( ':', $mode, 2 );
				$body['last_error'] = isset( $parts[1] ) ? $parts[1] : null;
			}
		}

		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $body ),
			'response' => array(
				'code'    => $code,
				'message' => 'OK',
			),
			'cookies'  => array(),
			'filename' => null,
		);
	},
	10,
	3
);
