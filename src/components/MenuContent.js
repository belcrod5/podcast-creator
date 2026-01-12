const React = require('react');
const { 
  Box, 
  List, 
  Toolbar, 
  Divider, 
  ListItem, 
  ListItemButton, 
  ListItemIcon, 
  ListItemText 
} = require('@mui/material');
const { 
  RecordVoiceOver: VoiceIcon,
  Podcasts: PodcastsIcon,
  Settings: SettingsIcon
} = require('@mui/icons-material');
const { Link, useLocation } = require('react-router-dom');

const MenuContent = () => {
  const location = useLocation();
  
  return (
    <Box>
      <Toolbar />
      <Divider />
      <List>
        <ListItem disablePadding>
          <ListItemButton 
            component={Link} 
            to="/tts"
            selected={location.pathname === '/tts'}
          >
            <ListItemIcon>
              <VoiceIcon />
            </ListItemIcon>
            <ListItemText primary="話者一覧" />
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton 
            component={Link} 
            to="/podcast"
            selected={location.pathname === '/podcast'}
          >
            <ListItemIcon>
              <PodcastsIcon />
            </ListItemIcon>
            <ListItemText primary="ポッドキャスト" />
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton
            component={Link}
            to="/settings"
            selected={location.pathname === '/settings'}
          >
            <ListItemIcon>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary="設定" />
          </ListItemButton>
        </ListItem>
      </List>
    </Box>
  );
};

module.exports = MenuContent;
