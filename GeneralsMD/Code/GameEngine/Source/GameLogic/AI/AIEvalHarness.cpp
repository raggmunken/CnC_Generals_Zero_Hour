/*
**	Command & Conquer Generals Zero Hour(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// AIEvalHarness.cpp

#include "PreRTS.h"	// This must go first in EVERY cpp file int the GameEngine

#include "GameLogic/AIEvalHarness.h"

#include "Common/GameCommon.h"
#include "Common/GameEngine.h"
#include "Common/GlobalData.h"
#include "Common/NameKeyGenerator.h"
#include "Common/Player.h"
#include "Common/PlayerList.h"
#include "Common/ScoreKeeper.h"
#include "GameLogic/GameLogic.h"
#include "GameLogic/VictoryConditions.h"

#include <stdio.h>

//-----------------------------------------------------------------------------
// Match-local state. One match per process, so file statics are sufficient.
//-----------------------------------------------------------------------------

static Bool s_reported = FALSE;

/// How often we test for an end condition. Victory does not need 30Hz.
static const Int EVAL_CHECK_INTERVAL_FRAMES = 30;

//=============================================================================
Bool AIEvalHarness::isEnabled( void )
{
	return TheGlobalData && TheGlobalData->m_aiEvalOutputFile.isNotEmpty();
}

//=============================================================================
void AIEvalHarness::reset( void )
{
	s_reported = FALSE;
}

//=============================================================================
/**
 * Distinguish real participants from neutral and civilian sides.
 *
 * Testing "has this player ever built anything" is more robust than trusting
 * the player type, because maps vary in how they declare non-participating
 * sides. By the time a match resolves, every genuine contender has produced
 * something and the scenery sides have not.
 */
Bool AIEvalHarness::isContender( Player *p )
{
	if( p == NULL )
		return FALSE;

	PlayerType t = p->getPlayerType();
	if( t != PLAYER_HUMAN && t != PLAYER_COMPUTER )
		return FALSE;

	ScoreKeeper *score = p->getScoreKeeper();
	if( score == NULL )
		return FALSE;

	return ( score->getTotalUnitsBuilt() > 0 ) || ( score->getTotalBuildingsBuilt() > 0 );
}

//=============================================================================
/**
 * Append one record for the match, then ask the engine to shut down.
 *
 * The format is deliberately flat key=value text: trivial to parse from a
 * shell or Python driver, and survives being concatenated across runs.
 */
void AIEvalHarness::report( const char *reason, Player *winner )
{
	if( s_reported )
		return;

	s_reported = TRUE;

	FILE *f = fopen( TheGlobalData->m_aiEvalOutputFile.str(), "a" );
	if( f == NULL )
	{
		DEBUG_LOG(( "AIEvalHarness: could not open '%s' for append\n",
								TheGlobalData->m_aiEvalOutputFile.str() ));
		TheGameEngine->setQuitting( TRUE );
		return;
	}

	UnsignedInt endFrame = TheGameLogic ? TheGameLogic->getFrame() : 0;

	// A match launched with -file carries its map in m_initialFile rather than
	// m_mapName, so fall back rather than reporting an empty field.
	AsciiString mapName = TheGlobalData->m_mapName;
	if( mapName.isEmpty() )
		mapName = TheGlobalData->m_initialFile;

	fprintf( f, "RESULT reason=%s endFrame=%u map=%s winner=%d\n",
					 reason,
					 endFrame,
					 mapName.str(),
					 winner ? winner->getPlayerIndex() : -1 );

	if( ThePlayerList )
	{
		for( Int i = 0; i < ThePlayerList->getPlayerCount(); ++i )
		{
			Player *p = ThePlayerList->getNthPlayer( i );
			if( !isContender( p ) )
				continue;

			ScoreKeeper *score = p->getScoreKeeper();

			const Bool usedSmartAI =
					( p->getPlayerType() == PLAYER_COMPUTER )
					&& ( TheGlobalData->m_smartAIPlayerMask & ( 1 << p->getPlayerIndex() ) ) != 0;

			const Bool defeated =
					TheVictoryConditions
					? TheVictoryConditions->hasSinglePlayerBeenDefeated( p ) : FALSE;

			fprintf( f,
							 "PLAYER idx=%d name=%s ai=%s defeated=%d "
							 "unitsBuilt=%d unitsLost=%d unitsKilled=%d "
							 "bldgBuilt=%d bldgLost=%d bldgKilled=%d "
							 "earned=%d spent=%d\n",
							 p->getPlayerIndex(),
							 KEYNAME( p->getPlayerNameKey() ).str(),
							 ( p->getPlayerType() == PLAYER_HUMAN ) ? "human" : ( usedSmartAI ? "smart" : "stock" ),
							 defeated ? 1 : 0,
							 score->getTotalUnitsBuilt(),
							 score->getTotalUnitsLost(),
							 score->getTotalUnitsDestroyed(),
							 score->getTotalBuildingsBuilt(),
							 score->getTotalBuildingsLost(),
							 score->getTotalBuildingsDestroyed(),
							 score->getTotalMoneyEarned(),
							 score->getTotalMoneySpent() );
		}
	}

	fprintf( f, "END\n" );
	fclose( f );

	TheGameEngine->setQuitting( TRUE );
}

//=============================================================================
void AIEvalHarness::update( void )
{
	if( !isEnabled() || s_reported )
		return;

	if( TheGameLogic == NULL || !TheGameLogic->isInGame() )
		return;

	UnsignedInt frame = TheGameLogic->getFrame();

	// Throttle: scanning the player list every frame buys nothing.
	if( frame % EVAL_CHECK_INTERVAL_FRAMES != 0 )
		return;

	// A stalemate must not hang the batch. Two AIs that turtle can run
	// indefinitely, so the driver needs a bounded worst case per match.
	if( TheGlobalData->m_aiEvalMaxFrames > 0
			&& frame >= (UnsignedInt)TheGlobalData->m_aiEvalMaxFrames )
	{
		report( "timeout", NULL );
		return;
	}

	if( ThePlayerList == NULL || TheVictoryConditions == NULL )
		return;

	// Count contenders still standing.
	Int alive = 0;
	Player *lastAlive = NULL;
	Int contenders = 0;

	for( Int i = 0; i < ThePlayerList->getPlayerCount(); ++i )
	{
		Player *p = ThePlayerList->getNthPlayer( i );
		if( !isContender( p ) )
			continue;

		contenders++;

		if( !TheVictoryConditions->hasSinglePlayerBeenDefeated( p ) )
		{
			alive++;
			lastAlive = p;
		}
	}

	// Before anyone has built anything there are no contenders yet; that is
	// the opening seconds of the match, not a finished one.
	if( contenders < 2 )
		return;

	if( alive == 1 )
		report( "victory", lastAlive );
	else if( alive == 0 )
		report( "mutual_destruction", NULL );
}
