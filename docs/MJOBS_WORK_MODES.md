# MJobs automatic work modes

Fleet Control has one selector for the active automatic dispatcher.

| Mode | Behavior |
| --- | --- |
| Paused | Stops new automatic assignments; running agents can finish. |
| Steady | Continuously refills eligible idle agents with ready work. This was previously called Sustained. |
| Turbo | Refills work and coordinates priorities, owned CI repairs, and independent PR reviews. |

Steady and Turbo are alternatives. Selecting either safely stops the previous dispatcher, waits for its current dispatch cycle to settle, and enables the chosen mode. Running model turns are preserved.

All modes retain quota, resource, ownership and delivery-receipt protections. Selecting Turbo does not override the configured 7% reserve. A rejected or uncertain request is followed by a status read; the UI never blindly repeats a write. Pause remains available when current mode telemetry is unavailable.

Advanced Steady capacity and Turbo settings remain separate because the two dispatchers plan different work. Mission Control links to this canonical selector rather than offering a second mode switch.

Source ownership remains in Fleet-Control-Hub. The UI repair does not activate session lifecycle cleanup or mutate private conversation history.