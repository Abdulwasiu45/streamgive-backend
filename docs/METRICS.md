# Metrics reference

`GET /metrics` exposes Prometheus text. Counters reset when the process restarts. Use `rate()` or `increase()` for counter dashboards.

| Metric                                           | Type      | Labels                     | Meaning                                                                                                  |
| ------------------------------------------------ | --------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| streamgive_http_requests_total                   | Counter   | method, route, status_code | Requests handled                                                                                         |
| streamgive_http_request_duration_seconds         | Histogram | method, route, status_code | Request duration in seconds. Bucket samples also carry `le`, with `_sum` and `_count` series for totals. |
| process_cpu_seconds_total                        | Counter   | None                       | Combined user and system CPU time                                                                        |
| process_start_time_seconds                       | Gauge     | None                       | Process start time as Unix seconds                                                                       |
| process_resident_memory_bytes                    | Gauge     | None                       | Resident memory                                                                                          |
| nodejs_heap_size_total_bytes                     | Gauge     | None                       | Total V8 heap size                                                                                       |
| nodejs_heap_size_used_bytes                      | Gauge     | None                       | Used V8 heap size                                                                                        |
| nodejs_external_memory_bytes                     | Gauge     | None                       | Memory for native objects bound to JavaScript                                                            |
| nodejs_arraybuffer_bytes                         | Gauge     | None                       | Allocated ArrayBuffer and SharedArrayBuffer memory                                                       |
| nodejs_eventloop_utilization                     | Gauge     | None                       | Fraction of event-loop time busy since process start                                                     |
| streamgive_indexer_checkpoint_ledger             | Gauge     | None                       | Last checkpointed ledger                                                                                 |
| streamgive_indexer_latest_ledger                 | Gauge     | None                       | Latest ledger observed from Stellar RPC                                                                  |
| streamgive_indexer_lag_ledgers                   | Gauge     | None                       | Latest observed ledger minus checkpoint, bounded below by zero                                           |
| streamgive_indexer_events_processed_total        | Counter   | None                       | Successfully processed events                                                                            |
| streamgive_indexer_events_dead_lettered_total    | Counter   | None                       | Events stored as dead letters                                                                            |
| streamgive_indexer_events_skipped_total          | Counter   | None                       | Confirmed skip-ahead operations                                                                          |
| streamgive_indexer_events_unknown_contract_total | Counter   | None                       | Events ignored because their contract is unwatched                                                       |
| streamgive_notification_deliveries_total         | Counter   | outcome                    | Webhook delivery attempts with `success` or `failure` outcome                                            |

## Suggested alert

Start with `streamgive_indexer_lag_ledgers > 100` for 10 minutes on the indexer target. Tune the threshold against normal catch-up behavior. Check scrape availability and checkpoint freshness separately because a stalled RPC poll can leave the last reported lag unchanged.
