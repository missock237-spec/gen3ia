"use client";

/**
 * Étape 2 — Canal de communication temps réel (useCopilotWebsocket).
 *
 * Hook gérant la connexion WebSocket PERSISTENTE vers la gateway live de
 * Gen3ia (transport bidirectionnel à faible latence : frames d'écran +
 * questions → réponses en streaming). Reconnexion automatique avec backoff
 * exponentiel (l'état de session est ré-authentifié à chaque reprise via
 * copilot.hello). Heartbeat régulier : la gateway considère un client muet
 * comme zombie et met la session en pause.
 *
 * URL de la gateway : NEXT_PUBLIC_LIVE_GATEWAY_URL (déploiements avancés)
 * ou, par défaut, wss://<hôte>/live-gateway — le reverse proxy Nginx route
 * ce chemin vers le process gateway (port 8787) avec l'upgrade WebSocket.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SocketStatus = "idle" | "connecting" | "connected" | "error" | "closed";

export interface CopilotSocketMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface UseCopilotWebsocketParams {
  sessionId: string | null;
  deviceId: string;
  pairingToken: string | null;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  onSocketStatus?: (status: SocketStatus) => void;
}

const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;

function gatewayUrl(): string {
  const override = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL?.trim();
  if (override) return override;
  if (typeof window === "undefined") return "";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/live-gateway`;
}

export function useCopilotWebsocket({
  sessionId,
  deviceId,
  pairingToken,
  onDelta,
  onDone,
  onError,
  onSocketStatus,
}: UseCopilotWebsocketParams) {
  const [status, setStatus] = useState<SocketStatus>("idle");
  const [frameSent, setFrameSent] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);
  const closedByUserRef = useRef(false);
  const askIdRef = useRef(0);
  const callbacksRef = useRef({ onDelta, onDone, onError, onSocketStatus });
  callbacksRef.current = { onDelta, onDone, onError, onSocketStatus };

  const emitStatus = useCallback((next: SocketStatus) => {
    setStatus(next);
    callbacksRef.current.onSocketStatus?.(next);
  }, []);

  const sendJson = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const stopAnswer = useCallback(() => {
    if (!sessionId) return;
    sendJson({ type: "copilot.stop", sessionId, deviceId });
  }, [deviceId, sessionId, sendJson]);

  const ask = useCallback(
    (text: string) => {
      if (!sessionId) return;
      askIdRef.current += 1;
      sendJson({ type: "copilot.ask", sessionId, deviceId, text: text.slice(0, 4000) });
    },
    [deviceId, sessionId, sendJson],
  );

  const sendFrame = useCallback(
    (jpegBase64: string, width: number, height: number) => {
      if (!sessionId) return;
      if (sendJson({ type: "frame", sessionId, deviceId, timestamp: Date.now(), width, height, jpegBase64 })) {
        setFrameSent((count) => count + 1);
      }
    },
    [deviceId, sessionId, sendJson],
  );

  useEffect(() => {
    if (!sessionId || !pairingToken) return;
    closedByUserRef.current = false;

    const connect = () => {
      emitStatus(attemptsRef.current === 0 ? "connecting" : "connecting");
      let socket: WebSocket;
      try {
        socket = new WebSocket(gatewayUrl());
      } catch {
        emitStatus("error");
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        attemptsRef.current = 0;
        socket.send(JSON.stringify({ type: "copilot.hello", sessionId, deviceId, pairingToken }));
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type: string; text?: string; message?: string; reason?: string };
          switch (message.type) {
            case "copilot.ack":
              emitStatus("connected");
              if (heartbeatRef.current) clearInterval(heartbeatRef.current);
              heartbeatRef.current = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: "heartbeat", sessionId, deviceId, timestamp: Date.now() }));
                }
              }, HEARTBEAT_MS);
              break;
            case "copilot.delta":
              if (message.text) callbacksRef.current.onDelta(message.text);
              break;
            case "copilot.done":
              callbacksRef.current.onDone();
              break;
            case "copilot.error":
              callbacksRef.current.onError(message.message ?? "Erreur du copilote.");
              break;
            case "stop":
              callbacksRef.current.onError(message.reason ?? "Session interrompue.");
              emitStatus("closed");
              break;
            default:
              break;
          }
        } catch {
          // message illisible : ignoré (le protocole ne doit jamais crasher l'UI)
        }
      };

      socket.onclose = () => {
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }
        if (closedByUserRef.current) {
          emitStatus("closed");
          return;
        }
        attemptsRef.current += 1;
        if (attemptsRef.current <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(1_000 * 2 ** (attemptsRef.current - 1), 15_000);
          setTimeout(connect, delay);
        } else {
          emitStatus("error");
        }
      };

      socket.onerror = () => {
        emitStatus("error");
      };
    };

    connect();

    return () => {
      closedByUserRef.current = true;
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      const socket = socketRef.current;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
      }
      socketRef.current = null;
    };
  }, [deviceId, emitStatus, pairingToken, sessionId]);

  return { status, ask, stopAnswer, sendFrame, frameSent };
}
