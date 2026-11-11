# Release speech fixture

`live-smoke-utterance.wav` is offline synthesized test speech, not a recording of a person. It uses eSpeak-NG through `@echogarden/espeak-ng-emscripten` 0.3.5, voice `en-us`, rate 145. The generator is not a runtime or application dependency.

Spoken text:

> Hi there. Yesterday I went to a cafe with my friend. Today I am thinking of visiting a park.

Format: PCM signed 16-bit little endian, mono, 22,050 Hz, 142,475 frames (6.461 seconds). `scripts/synthetic-audio.py` adds the same 8-second negotiation and 25-second response silence used by release acceptance.

The hosted Ubuntu runner already provides Google Chrome, which the functional browser suite also uses. Release acceptance uses that executable and this fixed speech file so it can run without downloading system fonts, a second browser or a speech synthesizer after publication. Access, source transcript, voice and save checks remain enabled.

To refresh the utterance with an installed eSpeak-NG CLI:

```sh
espeak-ng -v en-us -s 145 -w test/fixtures/live-smoke-utterance.wav "Hi there. Yesterday I went to a cafe with my friend. Today I am thinking of visiting a park."
```

Check the WAV header and run release acceptance after changing the file; different synthesizer versions may produce different frame counts.
