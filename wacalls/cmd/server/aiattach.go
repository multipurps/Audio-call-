package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	meowcaller "github.com/purpshell/meowcaller"

	"wacalls/internal/voip/call"
	"wacalls/internal/voip/core"
)

// aiSampleRate is the rate the Pipecat assistant expects (ACAF, 16 kHz mono). It is the same
// rate meowcaller uses for the call's audio.
const aiSampleRate = 16000

// aiAttachment is the AI leg of one call. The assistant hears the callee through Receive and
// speaks into the call through the call's audio source. Its voice is held until the callee
// answers, so the greeting is not heard while the phone is still ringing.
type aiAttachment struct {
	bridge   *AIBridge
	info     *aiReportInfo
	ac       *activeCall
	log      *slog.Logger
	released atomic.Bool // the callee answered: assistant audio flows
	ringing  atomic.Bool // "ringing" was reported to the app
	reported atomic.Bool // the end of the call was reported to the app
}

// onPhase is called from the call's state hook for every phase change.
func (a *aiAttachment) onPhase(p meowcaller.CallPhase) {
	switch p {
	case meowcaller.CallPhaseRinging:
		if a.ringing.CompareAndSwap(false, true) {
			go reportRelayStatus(a.log, a.info, "ringing")
		}
	case meowcaller.CallPhaseActive:
		a.ac.connectedAt.CompareAndSwap(0, time.Now().UnixMilli())
		if a.released.CompareAndSwap(false, true) {
			a.log.Info("aibridge: call answered, releasing assistant audio")
			go a.bridge.SignalCallActive()
		}
	}
}

// reportEnd tells the app how the call ended. It runs once per call.
func (a *aiAttachment) reportEnd(reason string) {
	if !a.reported.CompareAndSwap(false, true) {
		return
	}
	sd := call.CallStateData{EndReason: core.EndCallReason(reason)}
	if ms := a.ac.connectedAt.Load(); ms > 0 {
		t := time.UnixMilli(ms)
		sd.ConnectedAt = &t
		sd.DurationSecs = int(time.Since(t).Seconds())
	}
	go reportRelayOutcome(a.log, a.info, sd)
}

// attachAI connects the assistant to a call. It returns false when the call already has one.
func (s *Session) attachAI(ac *activeCall, callID string, bridge *AIBridge, info *aiReportInfo) bool {
	a := &aiAttachment{bridge: bridge, info: info, ac: ac, log: s.log}
	if !ac.ai.CompareAndSwap(nil, a) {
		return false
	}
	bridge.OnAssistantPCM = func(pcm []float32) {
		if !a.released.Load() {
			return // still ringing: the assistant is not heard yet
		}
		ac.src.push(pcm)
	}
	bridge.OnEnded = func() {
		s.log.Info("aibridge: assistant ended the call", "call_id", callID)
		go s.terminateCall(callID, string(core.EndCallReasonUserEnded))
	}
	// The callee's voice goes to the assistant. Browser audio is not used on an AI call.
	ac.call.Receive(meowcaller.SinkFunc(func(pcm []float32) { _ = bridge.WritePCM(pcm) }))
	ac.call.Play(ac.src)
	// The call may already be ringing or answered by the time the assistant connects.
	a.onPhase(ac.call.State())
	return true
}

func (s *server) handleAttachAI(w http.ResponseWriter, r *http.Request) {
	if sess := s.sessionByID(w, r.PathValue("sid")); sess != nil {
		s.doAttachAI(sess, w, r)
	}
}

func (s *server) doAttachAI(sess *Session, w http.ResponseWriter, r *http.Request) {
	callID := r.PathValue("id")
	ac, ok := sess.reg.get(callID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such call"})
		return
	}
	bridgeURL := os.Getenv("ASSISTANT_BRIDGE_URL")
	bridgeSecret := os.Getenv("ASSISTANT_BRIDGE_SECRET")
	if bridgeURL == "" || bridgeSecret == "" {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "ASSISTANT_BRIDGE_URL / ASSISTANT_BRIDGE_SECRET not configured"})
		return
	}
	var body struct {
		UserID       string `json:"userId"`
		AppSessionID string `json:"sessionId"`
		ContactName  string `json:"contactName"`
		PeerNumber   string `json:"peerNumber"`
		VoiceID      string `json:"voiceId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	bridge, err := NewAIBridge(bridgeURL, bridgeSecret, "call-"+callID, aiSampleRate, body.VoiceID, s.log)
	if err != nil {
		s.log.Error("aibridge: could not reach assistant", "call_id", callID, "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not reach assistant: " + err.Error()})
		return
	}
	info := &aiReportInfo{
		AppUserID:      body.UserID,
		AppSessionID:   body.AppSessionID,
		ContactName:    body.ContactName,
		PeerIdentifier: body.PeerNumber,
	}
	if !sess.attachAI(ac, callID, bridge, info) {
		bridge.Close()
		writeJSON(w, http.StatusConflict, map[string]string{"error": "assistant already attached"})
		return
	}
	s.log.Info("aibridge: attached", "call_id", callID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "attached"})
}
