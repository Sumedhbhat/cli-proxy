# Video review

Source: [If you have a Claude sub, watch this](https://www.youtube.com/watch?v=D8PikZ1KhUo), 66:36. Reviewed using the [available transcript](https://moderncreator.app/2026-10-02-theo-t3-gg-if-you-have-a-claude-sub-watch-this), with implementation details checked against upstream code and official client documentation.

| Segment | Topic | Treatment here |
| --- | --- | --- |
| 00:00 | Concurrent agent work | Context for the proxy |
| 02:00 | Sponsor | No implementation needed |
| 03:15 | Workflow roadmap | Context |
| 05:28 | Subscription economics | No price or savings assumptions in code |
| 11:04 | Data controls and account use | Account settings stay with providers |
| 15:22 | Proxy, quotas, reset order, affinity, WebSockets | Console, scheduler, upstream engine, gateway tunnel |
| 22:13 | Tailscale, machine setup, reset differences | Loopback listeners, setup instructions, provider-reported resets |
| 28:57 | Verification and reversible changes | Behavioral tests and priority backup |
| 38:32 | T3 threads and machine selection | Existing T3 workflow; outside the proxy |
| 49:45 | Concurrent threads as an inbox | Workflow advice; no background agent runner added |
| 58:43 | Always-on hardware | Deployment instructions; no machine provisioning |

This implementation builds the proxy portion. It does not purchase subscriptions, alter account privacy settings, share accounts, change your coding-client configuration, or provision other computers. Your existing T3 installation already handles the thread workflow discussed later in the video.
