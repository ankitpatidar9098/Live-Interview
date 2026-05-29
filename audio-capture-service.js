class AudioCaptureService {
  constructor() {
    this.micStream = null
    this.systemStream = null
    this.mediaRecorder = null
    this.audioChunks = []
    this.isRecording = false
    this.intervalId = null
  }

  // Auto-detect and configure capturing streams
  async startCapture(sourceId = null, onChunkCallback, onFallbackNotification) {
    this.audioChunks = []
    this.isRecording = true

    // 1. Microphone capture
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true
        }
      })
    } catch (err) {
      console.error("Microphone access blocked:", err)
      onFallbackNotification("Microphone Access Required: Please enable microphone permissions in your system settings.")
      return false
    }

    // 2. System Audio loopback capture
    if (sourceId) {
      try {
        // Chromium DesktopCapturer API captures system audio by mapping a chromeMediaSourceId
        this.systemStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: 1,
              maxWidth: 1280,
              maxHeight: 720
            }
          }
        })
      } catch (err) {
        console.warn("System Audio capture failed. Falling back to Mic-Only mode.", err)
        
        // Provide targeted OS-level instructions
        const osInstructions = this.getOSSetupInstructions()
        onFallbackNotification(osInstructions)
        
        // Fallback: System Audio is null, microphone stream handles everything
        this.systemStream = null
      }
    }

    // Combine streams using Web Audio API if both are present and have audio tracks
    let finalStream = this.micStream
    if (this.systemStream && this.systemStream.getAudioTracks().length > 0) {
      finalStream = this.mixAudioStreams(this.micStream, this.systemStream)
    }

    // Initialize recorder
    try {
      this.mediaRecorder = new MediaRecorder(finalStream, { mimeType: 'audio/webm' })
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })
        this.audioChunks = [] // clear chunk pool
        
        // Convert blob to base64 buffer and forward to callback
        const reader = new FileReader()
        reader.readAsDataURL(audioBlob)
        reader.onloadend = () => {
          const base64Data = reader.result.split(',')[1] // remove mime wrapper prefix
          if (onChunkCallback) onChunkCallback(base64Data)
        }
      }

      // Record in 2-second segments
      this.mediaRecorder.start()
      this.intervalId = setInterval(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop() // triggers dataavailable -> restarts recording cycle
          this.mediaRecorder.start()
        }
      }, 2000)

      return true
    } catch (recorderError) {
      console.error("Failed to start MediaRecorder loop:", recorderError)
      return false
    }
  }

  stopCapture() {
    this.isRecording = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }

    // Close active channels
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop())
      this.micStream = null
    }

    if (this.systemStream) {
      this.systemStream.getTracks().forEach(track => track.stop())
      this.systemStream = null
    }
  }

  // Web Audio Mixer Helper
  mixAudioStreams(stream1, stream2) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)()
    
    const source1 = audioContext.createMediaStreamSource(stream1)
    const source2 = audioContext.createMediaStreamSource(stream2)
    
    // Create gain nodes to balance volume (boosting the interviewer/system stream)
    const gainNode1 = audioContext.createGain()
    const gainNode2 = audioContext.createGain()
    
    gainNode1.gain.value = 1.0 // candidate mic
    gainNode2.gain.value = 1.5 // interviewer system loopback
    
    const destination = audioContext.createMediaStreamDestination()
    
    source1.connect(gainNode1)
    gainNode1.connect(destination)
    
    source2.connect(gainNode2)
    gainNode2.connect(destination)
    
    if (audioContext.state === 'suspended') {
      audioContext.resume()
    }
    
    return destination.stream
  }

  getOSSetupInstructions() {
    const isLinux = navigator.userAgent.includes('Linux')
    const isMac = navigator.userAgent.includes('Macintosh')

    if (isLinux) {
      return `System audio capture requires virtual loopbacks under PipeWire/PulseAudio.
Try running:
pactl load-module module-loopback latency_msec=1
Or open your audio settings and ensure a 'Monitor' device is active in your recording properties.`
    } else if (isMac) {
      return `On macOS, system audio loopback capture requires virtual loopback sound cards like BlackHole or Loopback. Please download BlackHole 2ch and select it inside your Audio MIDI utility.`
    } else {
      return `On Windows, ensure WASAPI Loopback settings are not blocked in your privacy console.`
    }
  }
}
export default AudioCaptureService;
