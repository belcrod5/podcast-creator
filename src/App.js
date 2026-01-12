const React = require('react');
const { HashRouter, Routes, Route, Navigate } = require('react-router-dom');

const AppLayout = require('./components/AppLayout');
const PodCastCreator = require('./components/PodCastCreator');
const { PodCastProvider } = require('./contexts/PodCastContext');
const SpeakerListView = require('./components/SpeakerListView');
const Settings = require('./components/Settings');

const App = () => {
  return (
    <HashRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Navigate to="/podcast" replace />} />
          <Route path="/tts" element={<SpeakerListView />} />
          <Route path="/settings" element={<Settings />} />
          <Route
            path="/podcast"
            element={
              <PodCastProvider>
                <PodCastCreator />
              </PodCastProvider>
            }
          />
        </Routes>
      </AppLayout>
    </HashRouter>
  );
};

module.exports = App;
