import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex items-center justify-center h-full bg-stone-100">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md text-center">
            <div className="text-red-500 text-lg font-semibold mb-2">Render Error</div>
            <div className="text-sm text-stone-600 mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </div>
            <button
              onClick={this.handleRetry}
              className="px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-sm font-medium"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
