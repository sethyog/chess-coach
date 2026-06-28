import { createContext, useContext, useState } from 'react';

const AnalysisContext = createContext(null);

export function AnalysisProvider({ children }) {
  const [analysingFormat, setAnalysingFormat] = useState(null);
  const [gameAnalysisProgress, setGameAnalysisProgress] = useState(null);

  return (
    <AnalysisContext.Provider value={{ analysingFormat, setAnalysingFormat, gameAnalysisProgress, setGameAnalysisProgress }}>
      {children}
    </AnalysisContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnalysis() {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error('useAnalysis must be used inside <AnalysisProvider>');
  return ctx;
}
