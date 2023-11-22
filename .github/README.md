Time|Job|Config
:-:|:-:|:-:
|00:35  | [watch](../src/Personal/watch.js) <br> [purge](../src/Clean/purge.js) <br> [mainpage-image-protection](../src/File/mainpageImages.js) | [1x evening](workflows/1x%20evening.yaml)
01:35 | [fix-redirect-category](../src/Category/fixRedirect.js) | [1x evening](workflows/1x%20evening.yaml)
02:35 | [nulledit-in-category](../src/Category/nulledit.js) <br> [file-info](../src/File/info.js) | [3x daily](workflows/3x%20daily.yaml)
03:35 | [userpage-deletion](../src/Clean/userpageDelete.js) <br> [redirect-deletion](../src/Clean/redirectDelete.js) <br> [invisible-character](../src/Clean/invisibleCharacter.js) | [4x daily](workflows/4x%20daily.yaml)
04:50 | [clean-sandbox](../src/Clean/sandbox.js) <br> [broken-redirect-deletion](../src/Clean/brokenRedirectDelete.js) <br> [check-activities](../src/Activity/maintainer.js) | [1x morning](workflows/1x%20morning.yaml)
05:55 | [bad-file-name](../src/Report/badFileName.js) (mon) <br> [most-transcluded-pages](../src/Report/mostTranscludedPages.js) (mon) <br> [broken-file-links](../src/Report/brokenFileLinks.js) (tue) <br> [short-pages](../src/Report/shortPages.js) (tue) <br> [need-improve](../src/Report/needImprove.js) (wed) <br> [need-improve-welcome](../src/Report/needImproveWelcome.js) (wed) <br> [group-leader-activities](../src/Activity/groupLeader.js) (thu) <br> fix-archives-anchor (thu) <br> language-conversion (sun) | [Activity](workflows/Activity.yaml) <br> [Report](workflows/Report.yaml)
06:55 | log-archive <br> talk-archive
10:35 | <div style="background:#ececec;color:grey;">同03:35</div>
11:35 | [interface-messages](../src/Interface/messages.js) (10th, 25th) | [Interface](workflows/Interface.yaml)
12:35 | [mark-abuser-status](../src/Blocked/markAbuserStatus.js) (mon) <br> [remove-userrights](../src/Blocked/removeUserrights.js) (mon) <br> [file-revision-deletion](../src/File/revisionDelete.js) (thu) <br> [add-category-redirect](../src/Category/redirectTemplate.js) (sat) | [Blocked](workflows/Blocked.yaml) <br> [Category](workflows/Category.yaml) <br> [File](workflows/File.yaml)
13:35 | [interface-protection](../src/Interface/protect.js) (mon, fri) | [Interface](workflows/Interface.yaml)
14:35 | <div style="background:#ececec;color:grey;">同02:35</div>
15:35 | [news-subscriber](../src/News/subscriber.js) (1st) <br> [override-category](../src/Internal/updateOverrideCategory.js) (2nd) <br> [need-improve-vtuber](../src/Report/needImproveVtuber.js) (3rd, 18th) <br> [navbox-fix-name](../src/Navbox/fixName.js) (4th) <br> [bad-display-title](../src/Report/badDisplayTitle.js) (6th, 21st) <br> [tentative-title](../src/Report/tentativeTitle.js) (7th, 22nd) <br> [news-protection](../src/News/protect.js) (8th) | [Internal](workflows/Internal.yaml) <br> [Navbox](workflows/Navbox.yaml) <br> [News](workflows/News.yaml) <br> [Report](workflows/Report.yaml)
16:35 | [hide-page-log](../src/Suppress/pageLog.js) (mon, fri) <br> [hide-user-log](../src/Suppress/userLog.js) (wed, sun) | [Suppress](workflows/Suppress.yaml)
17:35 | <div style="background:#ececec;color:grey;">同03:35</div>
19:35 | [group-member-activities](../src/Activity/groupMember.js) (10th, 25th) | [Activity](workflows/Activity.yaml)
20:35 | [abusefilter-update](../src/AbuseFilter/update.js) (thu, sun) | [AbuseFilter](workflows/AbuseFilter.yaml)
21:35 | <div style="background:#ececec;color:grey;">同02:35</div>
22:35 | <div style="background:#ececec;color:grey;">同03:35</div>
23:35 | [abusefilter-global](../src/AbuseFilter/global.js) (10th, 25th) | [AbuseFilter](workflows/AbuseFilter.yaml)
| Continuous | topiclist <br> signature <br> fix-anchor
| Manually | [news-sender](../src/News/sender.js) <br> [revoke-user](../src/Suppress/revokeUser.js) | [News](workflows/News.yaml) <br> [Suppress](workflows/Suppress.yaml)