import { createContext, useContext } from 'react';

export const TranscriptMediaActivity = createContext(true);
export function useTranscriptMediaActive() { return useContext(TranscriptMediaActivity); }
