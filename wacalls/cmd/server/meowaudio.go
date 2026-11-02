package main

import (
	"io"
	"math"
	"sync"
	"sync/atomic"
	"time"

	meowcaller "github.com/purpshell/meowcaller"
)

// liveAudioSource é um adaptador push/pull entre as mensagens PCM do data
// channel do browser (empurradas via push, em pedaços de tamanho arbitrário)
// e o AudioSource do meowcaller (puxado via ReadFrame, em quadros de tamanho
// fixo meowcaller.FrameSamples). O push vem do handler de mensagem do data
// channel WebRTC; o ReadFrame é chamado pela própria goroutine de playback
// do meowcaller assim que Call.Play(src) é conectado.
type liveAudioSource struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    []float32
	closed bool

	// counters for the call log: frames from the browser vs. silence we had to make up
	pulled atomic.Int64
	silent atomic.Int64
}

func newLiveAudioSource() *liveAudioSource {
	s := &liveAudioSource{}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// maxBufferedSamples caps the backlog (400 ms): a browser that sends in bursts must not build up delay.
const maxBufferedSamples = 6400

func (s *liveAudioSource) push(pcm []float32) {
	if len(pcm) == 0 {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.buf = append(s.buf, pcm...)
	if len(s.buf) > maxBufferedSamples { // keep the freshest 120 ms
		s.buf = append([]float32(nil), s.buf[len(s.buf)-meowcaller.FrameSamples*2:]...)
	}
	s.cond.Signal()
	s.mu.Unlock()
}

// ReadFrame is pulled by the call library every 60 ms. A real-time source must NEVER block the send loop:
// when the browser has not delivered a full frame (late, bursty, tab throttled, audio not started yet)
// it waits a few ms and then returns SILENCE, so the callee's phone always receives audio packets.
// Blocking here meant no audio at all while the browser was quiet, and a phone that gets no audio sits on
// "Connecting".
func (s *liveAudioSource) ReadFrame() ([]float32, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.buf) < meowcaller.FrameSamples && !s.closed {
		// brief grace period for a frame that is a few ms late
		timer := time.AfterFunc(15*time.Millisecond, func() {
			s.mu.Lock()
			s.cond.Broadcast()
			s.mu.Unlock()
		})
		s.cond.Wait()
		timer.Stop()
	}
	if s.closed && len(s.buf) < meowcaller.FrameSamples {
		return nil, io.EOF
	}
	if len(s.buf) < meowcaller.FrameSamples {
		s.silent.Add(1)
		return make([]float32, meowcaller.FrameSamples), nil
	}
	frame := append([]float32(nil), s.buf[:meowcaller.FrameSamples]...)
	s.buf = s.buf[meowcaller.FrameSamples:]
	s.pulled.Add(1)
	return frame, nil
}

func (s *liveAudioSource) Close() error {
	s.mu.Lock()
	s.closed = true
	s.cond.Broadcast()
	s.mu.Unlock()
	return nil
}

// holdToneSource é um AudioSource que gera um seno contínuo de 440 Hz (o
// clássico tom de espera) na taxa de quadros do meowcaller, até Close.
// Usado pra alimentar Call.Play enquanto a chamada está em hold — ver doHold
// em httpapi.go.
type holdToneSource struct {
	mu      sync.Mutex
	closed  bool
	samples uint64 // contador de amostras corrido, mantém a fase do seno contínua entre quadros
}

func newHoldToneSource() *holdToneSource {
	return &holdToneSource{}
}

const holdToneHz = 440.0

func (s *holdToneSource) ReadFrame() ([]float32, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, io.EOF
	}
	frame := make([]float32, meowcaller.FrameSamples)
	const amplitude = 0.2 // baixo o suficiente pra não assustar quem está em espera
	for i := range frame {
		t := float64(s.samples+uint64(i)) / float64(meowcaller.SampleRate)
		frame[i] = float32(amplitude * math.Sin(2*math.Pi*holdToneHz*t))
	}
	s.samples += uint64(len(frame))
	return frame, nil
}

func (s *holdToneSource) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}
