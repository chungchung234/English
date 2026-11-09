"""Pad the offline synthesized test utterance with negotiation/response silence."""
import sys,wave
with wave.open(sys.argv[1],'rb') as source:
 params=source.getparams();frames=source.readframes(params.nframes)
with wave.open(sys.argv[2],'wb') as target:
 target.setparams(params)
 silence=b'\0'*(params.framerate*params.sampwidth*params.nchannels)
 target.writeframes(silence*8+frames+silence*25)
