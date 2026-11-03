# ttballerbot player

This is a scoped redesign of the existing Discord music card. Discord owns the surrounding interface, native button styling, accessibility, and responsive layout.

The player borrows the composition of a record sleeve: original square album art, oversized Barlow Condensed track lettering, a quiet ttballerbot label, and deep green with mint accents. Friends use it while gaming or hanging out in a Discord voice call; the dark graphic belongs in that scene. The original green identity is retained.

The custom image carries the visual identity; native text repeats the actual title/artist for accessible reading and links. Status, progress and playback buttons sit directly below the image. The next three tracks form a numbered list with artist and duration. Add a song opens a modal; the full queue opens privately with page controls. The actual audio source remains visible.

Playing, loading, reconnecting, paused, idle, and stopped states must remain honest. No decorative waveform implies measured audio. Image failures never prevent playback or controls. Cache one image per current track; progress edits retain the existing attachment.

Colors: image background #0b1714, cover surround #152b23, main text #f0fff7, secondary text #bddbc9, accent #88e8b5. Native UI text and controls follow the Discord theme.
